import {Handler} from 'aws-lambda';
import {Tag} from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  ListTagsForResourceCommand,
  MetricAlarm,
  paginateDescribeAlarms,
  SetAlarmStateCommand,
} from '@aws-sdk/client-cloudwatch';
import * as logging from '@nr1e/logging';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';

const retryStrategy = new ConfiguredRetryStrategy(20);

const cloudwatch = new CloudWatchClient({
  region: process.env.AWS_REGION,
  retryStrategy: retryStrategy,
});

// Set up logging configuration with fallback to 'trace' level
const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'realarm-handler',
  level,
});

// Constants for rate limiting and retries
const DELAY_BETWEEN_BATCHES = 1000;
const DELAY_BETWEEN_PAGES = 2000;
const TAG_BATCH_SIZE = 5;
const TAG_RETRY_ATTEMPTS = 3;
const PAGE_SIZE = 20;
const THROTTLING_ERROR_CODES = [
  'ThrottlingException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
];
const BACKOFF_MULTIPLIER = 1.5;

/**
 * Tracks error metrics for monitoring and auto-adjustment
 */
interface ErrorMetrics {
  throttlingErrors: number;
  totalErrors: number;
  totalCalls: number;
  startTime: number;
}

const metrics: ErrorMetrics = {
  throttlingErrors: 0,
  totalErrors: 0,
  totalCalls: 0,
  startTime: 0,
};

/**
 * Reset metrics at the start of processing
 */
function resetMetrics() {
  metrics.throttlingErrors = 0;
  metrics.totalErrors = 0;
  metrics.totalCalls = 0;
  metrics.startTime = Date.now();
}

/**
 * Log metrics summary
 */
function logMetricsSummary() {
  const duration = Date.now() - metrics.startTime;
  log
    .info()
    .str('function', 'logMetricsSummary')
    .num('totalApiCalls', metrics.totalCalls)
    .num('throttlingErrors', metrics.throttlingErrors)
    .num('totalErrors', metrics.totalErrors)
    .num('durationMs', duration)
    .num(
      'callsPerSecond',
      (metrics.totalCalls / (duration / 1000)).toFixed(2) as unknown as number,
    )
    .msg('API call metrics summary');
}

// Utility functions
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk<T>(array: T[], size: number): T[][] {
  return Array.from({length: Math.ceil(array.length / size)}, (_, index) =>
    array.slice(index * size, index * size + size),
  );
}

interface AlarmWithTags extends MetricAlarm {
  Tags?: Tag[];
}

/**
 * Retry mechanism for fetching tags
 */
async function fetchTagsWithRetry(
  alarm: MetricAlarm,
  attempts: number = TAG_RETRY_ATTEMPTS,
): Promise<Tag[]> {
  for (let i = 0; i < attempts; i++) {
    try {
      const tagsResponse = await cloudwatch.send(
        new ListTagsForResourceCommand({
          ResourceARN: alarm.AlarmArn as string,
        }),
      );
      if (!tagsResponse.Tags) {
        throw new Error('No tags returned from ListTagsForResource');
      }
      return tagsResponse.Tags;
    } catch (error) {
      if (i === attempts - 1) {
        log
          .error()
          .str('function', 'fetchTagsWithRetry')
          .str('alarmName', alarm.AlarmName as string)
          .str('error', String(error))
          .num('attempt', i + 1)
          .msg('Failed to fetch tags after all retry attempts');
        throw new Error(
          `Failed to fetch tags for alarm ${alarm.AlarmName} after ${attempts} attempts: ${error}`,
        );
      }
      log
        .warn()
        .str('alarmName', alarm.AlarmName as string)
        .str('error', String(error))
        .num('attempt', i + 1)
        .msg('Retrying tag fetch after error');
      await delay(Math.pow(2, i) * 100); // Exponential backoff
    }
  }
  // This should never be reached due to the throw in the last iteration
  throw new Error('Unexpected end of fetchTagsWithRetry');
}

/**
 * Batch fetch tags for multiple alarms with retry mechanism
 */
async function batchFetchTags(
  alarms: MetricAlarm[],
  batchSize: number = TAG_BATCH_SIZE,
): Promise<AlarmWithTags[]> {
  const alarmsWithTags: AlarmWithTags[] = [];
  const batches = chunk(alarms, batchSize);
  let currentDelay = DELAY_BETWEEN_BATCHES;

  log
    .info()
    .str('function', 'batchFetchTags')
    .num('totalAlarms', alarms.length)
    .num('batchSize', batchSize)
    .num('totalBatches', batches.length)
    .msg('Starting batch tag fetching');

  for (const [batchIndex, batch] of batches.entries()) {
    const startTime = Date.now();
    let batchThrottleCount = 0;

    try {
      const tagPromises = batch.map(async (alarm) => {
        metrics.totalCalls++;
        const tags = await fetchTagsWithRetry(alarm);
        return {
          ...alarm,
          Tags: tags,
        } as AlarmWithTags;
      });

      const batchResults = await Promise.all(tagPromises);
      alarmsWithTags.push(...batchResults);

      const processingTime = Date.now() - startTime;

      // Adjust delay based on throttling
      if (batchThrottleCount > 0) {
        currentDelay = Math.min(currentDelay * BACKOFF_MULTIPLIER, 2000);
        log
          .warn()
          .str('function', 'batchFetchTags')
          .num('batchIndex', batchIndex)
          .num('throttleCount', batchThrottleCount)
          .num('newDelay', currentDelay)
          .msg('Increasing delay due to throttling');
      } else if (processingTime < currentDelay / 2) {
        currentDelay = Math.max(
          currentDelay / BACKOFF_MULTIPLIER,
          DELAY_BETWEEN_BATCHES,
        );
        log
          .info()
          .str('function', 'batchFetchTags')
          .num('batchIndex', batchIndex)
          .num('processingTime', processingTime)
          .num('newDelay', currentDelay)
          .msg('Decreasing delay due to good performance');
      }

      log
        .info()
        .str('function', 'batchFetchTags')
        .num('batchIndex', batchIndex)
        .num('batchSize', batch.length)
        .num('processingTime', processingTime)
        .num('appliedDelay', currentDelay)
        .msg('Batch processing complete');

      await delay(currentDelay);
    } catch (error) {
      metrics.totalErrors++;
      if (THROTTLING_ERROR_CODES.some((code) => String(error).includes(code))) {
        metrics.throttlingErrors++;
        batchThrottleCount++;
      }

      log
        .error()
        .str('function', 'batchFetchTags')
        .num('batchIndex', batchIndex)
        .str('error', String(error))
        .msg('Error processing batch');
      throw error;
    }
  }

  return alarmsWithTags;
}

/**
 * Unified alarm validation logic with detailed action logging
 */
function validateAlarm(alarm: AlarmWithTags, isOverride: boolean): boolean {
  // Log all actions for this alarm
  const actions = alarm.AlarmActions || [];
  log
    .info()
    .str('function', 'validateAlarm')
    .str('alarmName', alarm.AlarmName as string)
    .num('actionCount', actions.length)
    .str('actions', JSON.stringify(actions))
    .msg('Alarm actions found');

  // If there are autoscaling actions, log them specifically
  const autoscalingActions = actions.filter((action) =>
    action.includes('autoscaling'),
  );
  if (autoscalingActions.length > 0) {
    log
      .info()
      .str('function', 'validateAlarm')
      .str('alarmName', alarm.AlarmName as string)
      .num('autoscalingActionCount', autoscalingActions.length)
      .str('autoscalingActions', JSON.stringify(autoscalingActions))
      .msg('Autoscaling actions found - alarm will be excluded');
  }

  const reAlarmDisabled =
    alarm.Tags?.some(
      (tag) =>
        tag.Key === 'autoalarm:re-alarm-enabled' && tag.Value === 'false',
    ) ?? false;

  const reAlarmOverrideTag =
    alarm.Tags?.some(
      (tag) =>
        tag.Key === 'autoalarm:re-alarm-minutes' && !isNaN(Number(tag.Value)),
    ) ?? false;

  const hasAutoScalingAction = actions.some((action) =>
    action.includes('autoscaling'),
  );

  // Log the validation decision with all criteria
  log
    .info()
    .str('function', 'validateAlarm')
    .str('alarmName', alarm.AlarmName as string)
    .str('reAlarmDisabled', String(reAlarmDisabled))
    .str('reAlarmOverrideTag', String(reAlarmOverrideTag))
    .str('hasAutoScalingAction', String(hasAutoScalingAction))
    .str('isOverride', String(isOverride))
    .str(
      'isValid',
      String(
        !reAlarmDisabled &&
          !hasAutoScalingAction &&
          reAlarmOverrideTag === isOverride,
      ),
    )
    .msg('Alarm validation result');

  return (
    !reAlarmDisabled &&
    !hasAutoScalingAction &&
    reAlarmOverrideTag === isOverride
  );
}

/**
 * Process a batch of alarms and log results
 */
async function processAlarmBatch(
  alarms: MetricAlarm[],
  isOverride: boolean,
): Promise<MetricAlarm[]> {
  const alarmsWithTags = await batchFetchTags(alarms);
  const validAlarms = alarmsWithTags.filter((alarm) =>
    validateAlarm(alarm, isOverride),
  );

  log
    .info()
    .str('function', 'processAlarmBatch')
    .num('totalInBatch', alarms.length)
    .num('validInBatch', validAlarms.length)
    .str('isOverride', String(isOverride))
    .msg('Batch processing complete');

  return validAlarms;
}

/**
 * Retrieves and validates a specific override alarm
 */
async function getOverriddenAlarm(alarmName: string): Promise<MetricAlarm[]> {
  try {
    const response = await cloudwatch.send(
      new DescribeAlarmsCommand({AlarmNames: [alarmName]}),
    );

    if (!response.MetricAlarms?.length) {
      log
        .info()
        .str('function', 'getOverriddenAlarm')
        .str('alarmName', alarmName)
        .msg('Alarm not found');
      return [];
    }

    return processAlarmBatch(response.MetricAlarms, true);
  } catch (error) {
    log
      .error()
      .str('alarmName', alarmName)
      .str('error', String(error))
      .msg('Failed to fetch override alarm');
    throw error;
  }
}

/**
 * Retrieves and validates all standard schedule alarms
 */
async function getStandardReAlarmScheduledAlarms(): Promise<MetricAlarm[]> {
  resetMetrics();
  const validAlarms: MetricAlarm[] = [];
  let currentPageSize = PAGE_SIZE;
  let totalAlarmsProcessed = 0;
  let totalAutoScalingAlarms = 0;

  try {
    const paginator = paginateDescribeAlarms(
      {
        client: cloudwatch,
        pageSize: currentPageSize,
      },
      {
        AlarmTypes: ['MetricAlarm'],
        MaxRecords: currentPageSize,
      },
    );

    for await (const page of paginator) {
      metrics.totalCalls++;

      if (!page.MetricAlarms?.length) {
        log
          .info()
          .str('function', 'getStandardReAlarmScheduledAlarms')
          .msg('No alarms in page, continuing');
        continue;
      }

      totalAlarmsProcessed += page.MetricAlarms.length;

      // Log summary of actions for this page
      const pageActionSummary = page.MetricAlarms.reduce(
        (summary, alarm) => {
          const actions = alarm.AlarmActions || [];
          const hasAutoScaling = actions.some((action) =>
            action.includes('autoscaling'),
          );
          if (hasAutoScaling) {
            totalAutoScalingAlarms++;
            summary.autoScalingAlarms.push({
              name: alarm.AlarmName,
              actions: actions,
            });
          }
          summary.totalActions += actions.length;
          return summary;
        },
        {
          totalActions: 0,
          autoScalingAlarms: [] as {
            name: string | undefined;
            actions: string[];
          }[],
        },
      );

      log
        .info()
        .str('function', 'getStandardReAlarmScheduledAlarms')
        .num('pageSize', currentPageSize)
        .num('alarmsInPage', page.MetricAlarms.length)
        .num('totalActionsInPage', pageActionSummary.totalActions)
        .num(
          'autoScalingAlarmsInPage',
          pageActionSummary.autoScalingAlarms.length,
        )
        .msg('Processing page of alarms');

      // If we found any autoscaling alarms, log them specifically
      if (pageActionSummary.autoScalingAlarms.length > 0) {
        log
          .info()
          .str('function', 'getStandardReAlarmScheduledAlarms')
          .str(
            'autoScalingAlarms',
            JSON.stringify(pageActionSummary.autoScalingAlarms, null, 2),
          )
          .msg('Found alarms with autoscaling actions');
      }

      try {
        const validAlarmsInBatch = await processAlarmBatch(
          page.MetricAlarms,
          false,
        );
        validAlarms.push(...validAlarmsInBatch);

        // Log the results of validation
        log
          .info()
          .str('function', 'getStandardReAlarmScheduledAlarms')
          .num('alarmsInBatch', page.MetricAlarms.length)
          .num('validAlarmsInBatch', validAlarmsInBatch.length)
          .num(
            'invalidAlarmsInBatch',
            page.MetricAlarms.length - validAlarmsInBatch.length,
          )
          .msg('Batch validation complete');

        await delay(DELAY_BETWEEN_PAGES);
      } catch (error) {
        if (
          THROTTLING_ERROR_CODES.some((code) => String(error).includes(code))
        ) {
          metrics.throttlingErrors++;
          currentPageSize = Math.max(Math.floor(currentPageSize / 2), 10);
          log
            .warn()
            .str('function', 'getStandardReAlarmScheduledAlarms')
            .num('newPageSize', currentPageSize)
            .str('error', String(error))
            .msg('Reducing page size due to throttling');
        }
        throw error;
      }
    }

    logMetricsSummary();

    // Log final summary
    log
      .info()
      .str('function', 'getStandardReAlarmScheduledAlarms')
      .num('totalAlarmsProcessed', totalAlarmsProcessed)
      .num('totalValidAlarms', validAlarms.length)
      .num('totalAutoScalingAlarms', totalAutoScalingAlarms)
      .num('totalInvalidAlarms', totalAlarmsProcessed - validAlarms.length)
      .msg('Completed processing all alarms');

    return validAlarms;
  } catch (error) {
    metrics.totalErrors++;
    log
      .error()
      .str('function', 'getStandardReAlarmScheduledAlarms')
      .unknown('error', error)
      .num('totalAlarmsProcessed', totalAlarmsProcessed)
      .num('validAlarmsFound', validAlarms.length)
      .msg('Failed to fetch and process alarms');
    throw error;
  }
}

/**
 * Resets the state of a given alarm to 'OK'
 */
async function resetAlarmState(
  alarmName: string,
  override: boolean,
): Promise<void> {
  const stateReason = override
    ? 'Resetting state from reAlarm override Lambda function'
    : 'Resetting state from reAlarm Lambda function';
  try {
    await cloudwatch.send(
      new SetAlarmStateCommand({
        AlarmName: alarmName,
        StateValue: 'OK',
        StateReason: stateReason,
      }),
    );
    log
      .info()
      .str('function', 'resetAlarmState')
      .str('alarmName', alarmName)
      .str('isOverride', String(override))
      .msg(`Successfully reset alarm: ${alarmName}`);
  } catch (error) {
    log
      .fatal()
      .str('function', 'resetAlarmState')
      .str('alarmName', alarmName)
      .msg(`Failed to reset alarm: ${alarmName}. Error: ${error}`);
    throw error;
  }
}

/**
 * Main function to process and reset alarms
 */
async function checkAndResetAlarms(
  reAlarmOverride: boolean,
  overrideAlarmName?: string,
): Promise<void> {
  if (reAlarmOverride && !overrideAlarmName) {
    throw new Error(
      'overrideAlarmName is required when reAlarmOverride is true',
    );
  }

  const alarms = reAlarmOverride
    ? await getOverriddenAlarm(overrideAlarmName!)
    : await getStandardReAlarmScheduledAlarms();

  if (!alarms.length) {
    log.info().str('function', 'checkAndResetAlarms').msg('No alarms to reset');
    return;
  }

  log
    .info()
    .str('function', 'checkAndResetAlarms')
    .str('reAlarmOverride', String(reAlarmOverride))
    .num('alarmCount', alarms.length)
    .msg('Resetting alarms');

  await Promise.all(
    alarms.map((alarm) =>
      resetAlarmState(alarm.AlarmName as string, reAlarmOverride),
    ),
  );
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler: Handler = async (event: any): Promise<void> => {
  log
    .trace()
    .unknown('event', event)
    .str(
      'isOverriden Alarm',
      event['reAlarmOverride-AlarmName'] ? 'true' : 'false',
    )
    .str('overrideAlarmName', event['reAlarmOverride-AlarmName'] ?? '')
    .msg('Received event');

  await checkAndResetAlarms(
    !!event['reAlarmOverride-AlarmName'],
    event['reAlarmOverride-AlarmName'],
  );
};
