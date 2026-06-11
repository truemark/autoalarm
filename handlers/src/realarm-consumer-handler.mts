import {
  SQSHandler,
  SQSEvent,
  SQSBatchResponse,
  SQSBatchItemFailure,
  SQSRecord,
} from 'aws-lambda';
import {
  CloudWatchClient,
  ListTagsForResourceCommand,
  SetAlarmStateCommand,
  Tag,
} from '@aws-sdk/client-cloudwatch';
import * as logging from '@nr1e/logging';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';

// Retry up to 5 times with linear backoff (100ms + 1s per attempt) instead of
// hammering the API with constant-delay retries.
const retryStrategy = new ConfiguredRetryStrategy(
  5,
  (attempt) => 100 + attempt * 1000,
);
const cloudwatch = new CloudWatchClient({
  region: process.env.AWS_REGION,
  retryStrategy: retryStrategy,
});

// Set up logging configuration with fallback to 'info' level
const level = process.env.LOG_LEVEL || 'info';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'realarm-consumer',
  level,
});

// Constants for rate limiting and retries
const TAG_RETRY_ATTEMPTS = 3;
const DELAY_BETWEEN_OPERATIONS = 200;
const THROTTLING_ERROR_CODES = [
  'Throttling', // CloudWatch (Query protocol) throttle error name
  'ThrottlingException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
  'RequestThrottled', // SQS throttle error name
];
const BACKOFF_MULTIPLIER = 1.5;

/**
 * Detects throttling errors by matching the error name (precise) and falling
 * back to a message substring match for wrapped/stringified errors.
 */
function isThrottlingError(error: unknown): boolean {
  const errorName = error instanceof Error ? error.name : '';
  return THROTTLING_ERROR_CODES.some(
    (code) => errorName === code || String(error).includes(code),
  );
}
const MAX_CONCURRENT_TAG_REQUESTS = 5;
const TAG_REQUEST_DELAY = 200; // 200ms between requests

interface AlarmMessage {
  alarmName: string;
  alarmArn: string;
  alarmActions: string[];
  isOverride?: boolean;
}

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

function resetMetrics() {
  metrics.throttlingErrors = 0;
  metrics.totalErrors = 0;
  metrics.totalCalls = 0;
  metrics.startTime = Date.now();
}

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchTagsWithRetry(
  alarm: AlarmMessage,
  attempts: number = TAG_RETRY_ATTEMPTS,
): Promise<Tag[]> {
  for (let i = 0; i < attempts; i++) {
    try {
      metrics.totalCalls++;
      const tagsResponse = await cloudwatch.send(
        new ListTagsForResourceCommand({
          ResourceARN: alarm.alarmArn,
        }),
      );

      if (!tagsResponse.Tags) {
        throw new Error('No tags returned from ListTagsForResource');
      }
      return tagsResponse.Tags;
    } catch (error) {
      if (isThrottlingError(error)) {
        metrics.throttlingErrors++;
      }

      if (i === attempts - 1) {
        log
          .error()
          .str('function', 'fetchTagsWithRetry')
          .str('alarmName', alarm.alarmName)
          .str('error', String(error))
          .num('attempt', i + 1)
          .msg('Failed to fetch tags after all retry attempts');
        throw new Error(
          `Failed to fetch tags for alarm ${alarm.alarmName} after ${attempts} attempts: ${error}`,
        );
      }

      log
        .warn()
        .str('function', 'fetchTagsWithRetry')
        .str('alarmName', alarm.alarmName)
        .str('error', String(error))
        .num('attempt', i + 1)
        .msg('Retrying tag fetch after error');

      await delay(Math.pow(2, i) * 100); // Exponential backoff
    }
  }
  throw new Error('Unexpected end of fetchTagsWithRetry');
}

function chunk<T>(array: T[], size: number): T[][] {
  return Array.from({length: Math.ceil(array.length / size)}, (_, index) =>
    array.slice(index * size, index * size + size),
  );
}

// Create a rate limiter utility
async function rateLimitedTagFetch(alarms: AlarmMessage[]): Promise<{
  tagResults: Map<string, Tag[]>;
  failedArns: Set<string>;
}> {
  const tagResults = new Map<string, Tag[]>();
  const failedArns = new Set<string>();

  // Process alarms in smaller chunks
  const chunks = chunk(alarms, MAX_CONCURRENT_TAG_REQUESTS);

  for (const chunk of chunks) {
    // Process each chunk concurrently but with controlled parallelism
    const chunkPromises = chunk.map(async (alarm) => {
      try {
        const tags = await fetchTagsWithRetry(alarm);
        tagResults.set(alarm.alarmArn, tags);
      } catch (error) {
        // Track the failure - without tags we cannot honor opt-outs like
        // autoalarm:re-alarm-enabled=false, so the caller must not process
        // this alarm with an empty tag set.
        failedArns.add(alarm.alarmArn);
        log
          .error()
          .str('function', 'rateLimitedTagFetch')
          .str('alarmArn', alarm.alarmArn)
          .str('error', String(error))
          .msg('Failed to fetch tags for alarm');
      }
      // Add delay between requests within chunk
      await delay(TAG_REQUEST_DELAY);
    });

    // Wait for current chunk to complete before moving to next
    await Promise.all(chunkPromises);
  }

  return {tagResults, failedArns};
}

function validateAlarm(alarm: AlarmMessage, tags: Tag[]): boolean {
  // Log all actions for this alarm
  log
    .info()
    .str('function', 'validateAlarm')
    .str('alarmName', alarm.alarmName)
    .num('actionCount', alarm.alarmActions.length)
    .str('actions', JSON.stringify(alarm.alarmActions))
    .msg('Alarm actions found');

  // If there are autoscaling actions, log them specifically.
  // Match on the ARN service segment (arn:aws:<service>:...) rather than a
  // substring of the whole ARN so that e.g. an SNS topic named
  // "my-autoscaling-alerts" does not exclude its alarm. EC2 Auto Scaling
  // policies use the 'autoscaling' service; Application Auto Scaling uses
  // 'application-autoscaling'.
  const autoscalingActions = alarm.alarmActions.filter((action) => {
    const service = action.split(':')[2];
    return service === 'autoscaling' || service === 'application-autoscaling';
  });
  if (autoscalingActions.length > 0) {
    log
      .info()
      .str('function', 'validateAlarm')
      .str('alarmName', alarm.alarmName)
      .num('autoscalingActionCount', autoscalingActions.length)
      .str('autoscalingActions', JSON.stringify(autoscalingActions))
      .msg('Autoscaling actions found - alarm will be excluded');
  }

  const reAlarmDisabled = tags.some(
    (tag) => tag.Key === 'autoalarm:re-alarm-enabled' && tag.Value === 'false',
  );

  // Only a real positive integer counts as an override (mirrors the tag-event
  // handler). Number('') === 0, so a bare !isNaN check would treat ''/' '/'0'
  // as an override and exclude the alarm from BOTH re-alarm paths.
  const reAlarmOverrideTag = tags.some((tag) => {
    if (tag.Key !== 'autoalarm:re-alarm-minutes') {
      return false;
    }
    const minutes = Number(tag.Value);
    return Number.isInteger(minutes) && minutes > 0;
  });

  const hasAutoScalingAction = autoscalingActions.length > 0;

  // Log the validation decision with all criteria
  log
    .info()
    .str('function', 'validateAlarm')
    .str('alarmName', alarm.alarmName)
    .str('autoalarm:re-alarm-enabled', reAlarmDisabled ? 'false' : 'true')
    .str('reAlarmOverrideTag', String(reAlarmOverrideTag))
    .str('hasAutoScalingAction', String(hasAutoScalingAction))
    .str('isOverride', String(alarm.isOverride))
    .str(
      'isValid',
      String(
        !reAlarmDisabled &&
          !hasAutoScalingAction &&
          reAlarmOverrideTag === alarm.isOverride,
      ),
    )
    .msg('Alarm validation result');

  return (
    !reAlarmDisabled &&
    !hasAutoScalingAction &&
    reAlarmOverrideTag === alarm.isOverride
  );
}

async function resetAlarmState(
  alarmName: string,
  isOverride: boolean,
): Promise<void> {
  const stateReason = isOverride
    ? 'Resetting state from reAlarm override Lambda function'
    : 'Resetting state from reAlarm Lambda function';

  try {
    metrics.totalCalls++;
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
      .str('isOverride', String(isOverride))
      .msg(`Successfully reset alarm: ${alarmName}`);
  } catch (error) {
    metrics.totalErrors++;
    if (isThrottlingError(error)) {
      metrics.throttlingErrors++;
    }

    log
      .fatal()
      .str('function', 'resetAlarmState')
      .str('alarmName', alarmName)
      .str('error', String(error))
      .msg(`Failed to reset alarm: ${alarmName}`);
    throw error;
  }
}

let currentDelay = DELAY_BETWEEN_OPERATIONS;

async function processAlarm(message: AlarmMessage, tags: Tag[]): Promise<void> {
  try {
    const startTime = Date.now();
    let throttleCount = 0;

    try {
      if (validateAlarm(message, tags)) {
        // Reset the throttling error count before the next API call
        const previousThrottleErrors = metrics.throttlingErrors;
        await resetAlarmState(message.alarmName, message.isOverride || false);
        // Count any new throttling errors from resetAlarmState
        throttleCount += metrics.throttlingErrors - previousThrottleErrors;

        const processingTime = Date.now() - startTime;

        // Now our throttling adjustment will work properly
        if (throttleCount > 0) {
          currentDelay = Math.min(currentDelay * BACKOFF_MULTIPLIER, 2000);
          log
            .warn()
            .str('function', 'processAlarm')
            .str('alarmName', message.alarmName)
            .num('throttleCount', throttleCount)
            .num('newDelay', currentDelay)
            .msg('Increasing delay due to throttling');
        } else if (processingTime < currentDelay / 2) {
          currentDelay = Math.max(
            currentDelay / BACKOFF_MULTIPLIER,
            DELAY_BETWEEN_OPERATIONS,
          );
          log
            .info()
            .str('function', 'processAlarm')
            .str('alarmName', message.alarmName)
            .num('processingTime', processingTime)
            .num('newDelay', currentDelay)
            .msg('Decreasing delay due to good performance');
        }

        log
          .info()
          .str('function', 'processAlarm')
          .str('alarmName', message.alarmName)
          .str('finalDelay', String(currentDelay))
          .num('totalThrottleCount', throttleCount)
          .msg('Successfully processed alarm');
      } else {
        log
          .info()
          .str('function', 'processAlarm')
          .str('alarmName', message.alarmName)
          .msg('Alarm validation failed, skipping');
      }

      await delay(currentDelay);
    } catch (error) {
      // Handle errors from the API calls
      if (isThrottlingError(error)) {
        throttleCount++;
        currentDelay = Math.min(currentDelay * BACKOFF_MULTIPLIER, 2000);
        log
          .warn()
          .str('function', 'processAlarm')
          .str('alarmName', message.alarmName)
          .num('throttleCount', throttleCount)
          .num('newDelay', currentDelay)
          .str('error', String(error))
          .msg('Increasing delay due to throttling error');
      }
      throw error; // Re-throw to be handled by outer catch
    }
  } catch (error) {
    // Handle all errors
    log
      .error()
      .str('function', 'processAlarm')
      .str('alarmName', message.alarmName)
      .str('error', String(error))
      .msg('Failed to process alarm');
    throw error;
  }
}

export const handler: SQSHandler = async (
  event: SQSEvent,
): Promise<SQSBatchResponse> => {
  log
    .trace()
    .str('function', 'handler')
    .num('recordCount', event.Records.length)
    .msg('Processing SQS event');

  resetMetrics();

  /**
   * Create batch item failures array to store any failed items from the batch.
   */
  const batchItemFailures: SQSBatchItemFailure[] = [];
  const batchItemBodies: SQSRecord[] = [];

  // Keep the link between each parsed message and its originating SQS record
  // so failures can be attributed to the correct messageId.
  const parsedMessages = event.Records.flatMap((record) => {
    try {
      // Check if the record body contains an error message
      if (record.body && record.body.includes('errorMessage')) {
        log
          .warn()
          .str('messageId', record.messageId)
          .msg('Error message found in record body');
        return [];
      }
      return [{record, message: JSON.parse(record.body) as AlarmMessage}];
    } catch (error) {
      log
        .error()
        .str('messageId', record.messageId)
        .str('error', String(error))
        .msg('Error parsing record body');
      batchItemFailures.push({itemIdentifier: record.messageId});
      batchItemBodies.push(record);
      return [];
    }
  });

  // Fetch all tags upfront
  const {tagResults: tagCache, failedArns} = await rateLimitedTagFetch(
    parsedMessages.map(({message}) => message),
  );

  // Do not process alarms whose tag fetch failed - without tags we cannot
  // honor opt-outs (autoalarm:re-alarm-enabled=false). Report them as batch
  // item failures so SQS retries them.
  const processableMessages = parsedMessages.filter(({record, message}) => {
    if (failedArns.has(message.alarmArn)) {
      log
        .warn()
        .str('function', 'handler')
        .str('messageId', record.messageId)
        .str('alarmName', message.alarmName)
        .msg(
          'Skipping alarm because tag fetch failed - reporting for SQS retry',
        );
      batchItemFailures.push({itemIdentifier: record.messageId});
      batchItemBodies.push(record);
      return false;
    }
    return true;
  });

  try {
    // Process messages using cached tags
    const processingResults = await Promise.allSettled(
      processableMessages.map(({message}) =>
        processAlarm(message, tagCache.get(message.alarmArn) || []),
      ),
    );

    // Attribute failures by index - processingResults[i] corresponds to
    // processableMessages[i], which carries its originating SQS record.
    const failures = processingResults.filter((result, index) => {
      if (result.status === 'rejected') {
        const {record} = processableMessages[index];
        batchItemFailures.push({itemIdentifier: record.messageId});
        batchItemBodies.push(record);
        return true;
      }
      return false;
    });

    logMetricsSummary();

    if (failures.length > 0) {
      log
        .error()
        .str('function', 'handler')
        .num('failureCount', failures.length)
        .num('successCount', processingResults.length - failures.length)
        .msg('Some alarms failed to process');
      // No longer throw error here
    }

    log
      .info()
      .str('function', 'handler')
      .num('processedAlarms', processingResults.length)
      .msg('Successfully processed all alarms');
  } catch (error) {
    log
      .error()
      .str('function', 'handler')
      .str('error', String(error))
      .msg('Failed to process SQS event');

    // Instead of throwing, mark all remaining records as failed
    for (const record of event.Records) {
      if (
        !batchItemFailures.some((f) => f.itemIdentifier === record.messageId)
      ) {
        batchItemFailures.push({itemIdentifier: record.messageId});
        batchItemBodies.push(record);
      }
    }
  }

  if (batchItemFailures.length > 0) {
    log
      .info()
      .str('function', 'handler')
      .num('failedItems', batchItemFailures.length)
      .obj(
        'failedItemIds',
        batchItemFailures.map((f) => f.itemIdentifier),
      )
      .obj('failedItemBodies', batchItemBodies)
      .msg('Reporting failed items for partial batch processing');
  }

  // Return the batch item failures
  return {
    batchItemFailures: batchItemFailures,
  };
};
