import {SQSHandler, SQSEvent} from 'aws-lambda';
import {
  CloudWatchClient,
  ListTagsForResourceCommand,
  SetAlarmStateCommand,
  Tag,
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
  name: 'realarm-consumer',
  level,
});

// Constants for rate limiting and retries
const TAG_RETRY_ATTEMPTS = 3;
const DELAY_BETWEEN_OPERATIONS = 100;
const THROTTLING_ERROR_CODES = [
  'ThrottlingException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
];
const BACKOFF_MULTIPLIER = 1.5;

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
      if (THROTTLING_ERROR_CODES.some((code) => String(error).includes(code))) {
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

function validateAlarm(alarm: AlarmMessage, tags: Tag[]): boolean {
  // Log all actions for this alarm
  log
    .info()
    .str('function', 'validateAlarm')
    .str('alarmName', alarm.alarmName)
    .num('actionCount', alarm.alarmActions.length)
    .str('actions', JSON.stringify(alarm.alarmActions))
    .msg('Alarm actions found');

  // If there are autoscaling actions, log them specifically
  const autoscalingActions = alarm.alarmActions.filter((action) =>
    action.includes('autoscaling'),
  );
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

  const reAlarmOverrideTag = tags.some(
    (tag) =>
      tag.Key === 'autoalarm:re-alarm-minutes' && !isNaN(Number(tag.Value)),
  );

  const hasAutoScalingAction = autoscalingActions.length > 0;

  // Log the validation decision with all criteria
  log
    .info()
    .str('function', 'validateAlarm')
    .str('alarmName', alarm.alarmName)
    .str('reAlarmDisabled', String(reAlarmDisabled))
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
    if (THROTTLING_ERROR_CODES.some((code) => String(error).includes(code))) {
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

async function processAlarm(message: AlarmMessage): Promise<void> {
  try {
    const startTime = Date.now();
    let throttleCount = 0;

    try {
      // Track throttling from tag fetching
      const tags = await fetchTagsWithRetry(message);
      // Add the throttling errors we've seen so far
      throttleCount += metrics.throttlingErrors;

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
      if (THROTTLING_ERROR_CODES.some((code) => String(error).includes(code))) {
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

export const handler: SQSHandler = async (event: SQSEvent): Promise<void> => {
  log
    .trace()
    .str('function', 'handler')
    .num('recordCount', event.Records.length)
    .msg('Processing SQS event');

  resetMetrics();

  try {
    const processingResults = await Promise.allSettled(
      event.Records.map((record) => {
        const message: AlarmMessage = JSON.parse(record.body);
        return processAlarm(message);
      }),
    );

    const failures = processingResults.filter(
      (result) => result.status === 'rejected',
    );

    logMetricsSummary();

    if (failures.length > 0) {
      log
        .error()
        .str('function', 'handler')
        .num('failureCount', failures.length)
        .num('successCount', processingResults.length - failures.length)
        .msg('Some alarms failed to process');
      throw new Error('Some alarms failed to process');
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
    throw error;
  }
};
