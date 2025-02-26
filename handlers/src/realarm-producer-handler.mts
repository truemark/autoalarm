import {Handler} from 'aws-lambda';
import {
  CloudWatchClient,
  paginateDescribeAlarms,
  MetricAlarm,
  DescribeAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  SQSClient,
  SendMessageBatchCommand,
  SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import * as logging from '@nr1e/logging';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';

const retryStrategy = new ConfiguredRetryStrategy(20);
const cloudwatch = new CloudWatchClient({
  region: process.env.AWS_REGION,
  retryStrategy: retryStrategy,
});
const sqs = new SQSClient({region: process.env.AWS_REGION});

// Set up logging configuration with fallback to 'trace' level
const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'realarm-producer',
  level,
});

const DELAY_BETWEEN_BATCHES = 1000;
const PAGE_SIZE = 100;
const SQS_BATCH_SIZE = 10;
const THROTTLING_ERROR_CODES = [
  'ThrottlingException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
];
const BACKOFF_MULTIPLIER = 1.5;

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

function chunk<T>(array: T[], size: number): T[][] {
  return Array.from({length: Math.ceil(array.length / size)}, (_, index) =>
    array.slice(index * size, index * size + size),
  );
}

async function getOverriddenAlarm(alarmName: string): Promise<MetricAlarm[]> {
  try {
    // Fetch the specific alarm by name
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

    // Check if the alarm needs processing by verifying it's not already in OK state
    const alarm = response.MetricAlarms[0];
    if (alarm.StateValue === 'OK') {
      log
        .info()
        .str('function', 'getOverriddenAlarm')
        .str('alarmName', alarmName)
        .str('currentState', alarm.StateValue || 'UNKNOWN')
        .msg('Override alarm already in OK state, skipping');
      return [];
    }

    // If we get here, the alarm needs processing
    log
      .info()
      .str('function', 'getOverriddenAlarm')
      .str('alarmName', alarmName)
      .str('currentState', alarm.StateValue || 'UNKNOWN')
      .msg('Found override alarm requiring processing');

    return response.MetricAlarms;
  } catch (error) {
    log
      .error()
      .str('function', 'getOverriddenAlarm')
      .str('alarmName', alarmName)
      .str('error', String(error))
      .msg('Failed to fetch override alarm');
    throw error;
  }
}

async function sendAlarmsToSQS(
  alarms: MetricAlarm[],
  queueUrl: string,
  isOverride: boolean,
): Promise<void> {
  // Filter out alarms that are already in OK state
  const alarmsToProcess = alarms.filter((alarm) => {
    const isNotOk = alarm.StateValue !== 'OK';
    if (!isNotOk) {
      log
        .debug()
        .str('function', 'sendAlarmsToSQS')
        .str('alarmName', alarm.AlarmName || '')
        .str('state', alarm.StateValue || '')
        .msg('Skipping alarm already in OK state');
    }
    return isNotOk;
  });

  // Early return if no alarms need processing
  if (alarmsToProcess.length === 0) {
    log
      .info()
      .num('skippedAlarms', alarms.length)
      .msg('No alarms need processing - all in OK state');
    return;
  }

  // Process alarms in batches for efficiency
  const batches = chunk(alarmsToProcess, SQS_BATCH_SIZE);
  let currentDelay = DELAY_BETWEEN_BATCHES;

  log
    .info()
    .str('function', 'sendAlarmsToSQS')
    .num('totalAlarms', alarmsToProcess.length)
    .num('skippedAlarms', alarms.length - alarmsToProcess.length)
    .num('totalBatches', batches.length)
    .str('isOverride', String(isOverride))
    .msg('Starting to send alarms to SQS');

  // Process each batch of alarms
  for (const [batchIndex, batch] of batches.entries()) {
    const startTime = Date.now();
    let batchThrottleCount = 0;

    try {
      // Prepare messages for the batch
      const entries: SendMessageBatchRequestEntry[] = batch.map((alarm, i) => ({
        Id: `${batchIndex}-${i}`,
        MessageBody: JSON.stringify({
          alarmName: alarm.AlarmName,
          alarmArn: alarm.AlarmArn,
          alarmActions: alarm.AlarmActions || [],
          isOverride,
        }),
        MessageGroupId: 'reAlarm-Producer',
      }));

      // Send the batch to SQS
      const command = new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: entries,
      });

      metrics.totalCalls++;
      await sqs.send(command);

      const processingTime = Date.now() - startTime;

      // Adjust delay based on throttling and processing time
      if (batchThrottleCount > 0) {
        currentDelay = Math.min(currentDelay * BACKOFF_MULTIPLIER, 2000);
        log
          .warn()
          .str('function', 'sendAlarmsToSQS')
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
          .str('function', 'sendAlarmsToSQS')
          .num('batchIndex', batchIndex)
          .num('processingTime', processingTime)
          .num('newDelay', currentDelay)
          .msg('Decreasing delay due to good performance');
      }

      // Wait before processing next batch
      await delay(currentDelay);
    } catch (error) {
      metrics.totalErrors++;
      if (THROTTLING_ERROR_CODES.some((code) => String(error).includes(code))) {
        metrics.throttlingErrors++;
        batchThrottleCount++;
      }

      log
        .error()
        .str('function', 'sendAlarmsToSQS')
        .num('batchIndex', batchIndex)
        .str('error', String(error))
        .msg('Failed to send batch to SQS');
      throw error;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler: Handler = async (event: any): Promise<void> => {
  // Extract the actual event data from the nested structure
  const eventData = event.event || event; // Fallback to the original event if not nested

  log
    .trace()
    .str('function', 'handler')
    .unknown('event', event)
    .str(
      'isOverrideAlarm',
      eventData['reAlarmOverride-AlarmName'] ? 'true' : 'false',
    )
    .str('overrideAlarmName', eventData['reAlarmOverride-AlarmName'] ?? '')
    .msg('Received event');

  if (!process.env.CONSUMER_QUEUE_URL) {
    throw new Error('CONSUMER_QUEUE_URL environment variable is required');
  }

  resetMetrics();
  let totalAlarms = 0;

  try {
    if (eventData['reAlarmOverride-AlarmName']) {
      // Handle override alarm case
      const overrideAlarms = await getOverriddenAlarm(
        eventData['reAlarmOverride-AlarmName'],
      );
      if (overrideAlarms.length > 0) {
        await sendAlarmsToSQS(
          overrideAlarms,
          process.env.CONSUMER_QUEUE_URL,
          true,
        );
      }
    } else {
      // Handle standard alarms case
      const paginator = paginateDescribeAlarms(
        {client: cloudwatch, pageSize: PAGE_SIZE},
        {AlarmTypes: ['MetricAlarm']},
      );

      for await (const page of paginator) {
        if (!page.MetricAlarms?.length) {
          continue;
        }

        totalAlarms += page.MetricAlarms.length;
        await sendAlarmsToSQS(
          page.MetricAlarms,
          process.env.CONSUMER_QUEUE_URL,
          false,
        );

        log
          .info()
          .str('function', 'handler')
          .num('processedAlarms', totalAlarms)
          .msg('Processed page of alarms');
      }
    }

    logMetricsSummary();
  } catch (error) {
    log
      .error()
      .str('function', 'handler')
      .str('error', String(error))
      .num('processedAlarms', totalAlarms)
      .msg('Failed to process alarms');
    throw error;
  }
};
