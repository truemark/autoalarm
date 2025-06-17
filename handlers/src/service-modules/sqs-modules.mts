import {SQSClient, ListQueueTagsCommand} from '@aws-sdk/client-sqs';
import * as logging from '@nr1e/logging';
import {AlarmClassification, TagRecord} from '../types/index.mjs';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {
  deleteExistingAlarms,
  buildAlarmName,
  handleAnomalyAlarms,
  handleStaticAlarms,
  getCWAlarmsForInstance,
  parseMetricAlarmOptions,
} from '../alarm-configs/utils/index.mjs';
import {SQS_CONFIGS} from '../alarm-configs/index.mjs';

const log: logging.Logger = logging.getLogger('sqs-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const sqsClient: SQSClient = new SQSClient({
  region,
  retryStrategy,
});
const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region: region,
  retryStrategy: retryStrategy,
});

const metricConfigs = SQS_CONFIGS;

export async function fetchSQSTags(queueUrl: string): Promise<TagRecord> {
  try {
    const command = new ListQueueTagsCommand({QueueUrl: queueUrl});
    const response = await sqsClient.send(command);
    const tags: TagRecord = response.Tags || {};

    log
      .info()
      .str('function', 'fetchSQSTags')
      .str('queueUrl', queueUrl)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched SQS tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchSQSTags')
      .err(error)
      .str('queueUrl', queueUrl)
      .msg('Error fetching SQS tags');
    return {};
  }
}

async function checkAndManageSQSStatusAlarms(queueName: string, tags: TagRecord) {
  log
    .info()
    .str('function', 'checkAndManageSQSStatusAlarms')
    .str('QueueName', queueName)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageSQSStatusAlarms')
      .str('QueueName', queueName)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('SQS', queueName);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageSQSStatusAlarms')
      .obj('config', config)
      .str('SQS', queueName)
      .msg('Processing metric configuration');

    const tagValue = tags[`autoalarm:${config.tagKey}`];
    const updatedDefaults = parseMetricAlarmOptions(
      tagValue || '',
      config.defaults,
    );

    if (config.defaultCreate || tagValue !== undefined) {
      if (config.tagKey.includes('anomaly')) {
        log
          .info()
          .str('function', 'checkAndManageSQSStatusAlarms')
          .str('QueueName', queueName)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          'SQS',
          queueName,
          [{Name: 'QueueName', Value: queueName}],
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageSQSStatusAlarms')
          .str('QueueName', queueName)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          'SQS',
          queueName,
          [{Name: 'QueueName', Value: queueName}],
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageSQSStatusAlarms')
        .str('QueueName', queueName)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            'SQS',
            queueName,
            AlarmClassification.Warning,
            'static',
          ).replace('Warning', ''),
        )
        .msg(
          'No default or overridden alarm values. Marking alarms for deletion.',
        );
    }
  }

  // Delete alarms that are not in the alarmsToKeep set
  const existingAlarms = await getCWAlarmsForInstance('SQS', queueName);
  const alarmsToDelete = existingAlarms.filter(
    (alarm) => !alarmsToKeep.has(alarm),
  );

  log
    .info()
    .str('function', 'checkAndManageSQSStatusAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarm that is no longer needed');
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageSQSStatusAlarms')
    .str('QueueName', queueName)
    .msg('Finished alarm management process');
}

export async function manageSQSAlarms(
  queueName: string,
  tags: TagRecord,
): Promise<void> {
  await checkAndManageSQSStatusAlarms(queueName, tags);
}

export async function manageInactiveSQSAlarms(queueUrl: string) {
  const queueName = extractQueueName(queueUrl);
  try {
    await deleteExistingAlarms('SQS', queueName);
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveSQSAlarms')
      .err(e)
      .msg(`Error deleting SQS alarms: ${e}`);
    throw new Error(`Error deleting SQS alarms: ${e}`);
  }
}

function extractQueueName(queueUrl: string): string {
  const parts = queueUrl.split('/');
  log
    .debug()
    .str('function', 'extractQueueName')
    .str('queueUrl', queueUrl)
    .str('parts', JSON.stringify(parts))
    .str('queueName', parts.at(-1)!)
    .msg('Extracted queue name');
  if (!queueUrl) {
    log
      .error()
      .str('function', 'extractQueueName')
      .str('queueUrl', queueUrl ? queueUrl : 'undefined')
      .msg('Invalid queue URL: Queue name not found');
    throw new Error('Invalid queue URL: Queue name not found');
  }
  return parts.at(-1)!;
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseSQSEventAndCreateAlarms(event: any): Promise<{
  queueUrl: string;
  eventType: string;
  tags: Record<string, string>;
} | void> {
  let queueUrl: string = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateQueue':
          queueUrl = event.detail.responseElements?.queueUrl;
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseSQSEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('queueUrl', queueUrl)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateQueue event');
          if (queueUrl) {
            tags = await fetchSQSTags(queueUrl);
            log
              .info()
              .str('function', 'parseSQSEventAndCreateAlarms')
              .str('queueUrl', queueUrl)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new SQS queue');
          } else {
            log
              .error()
              .str('function', 'parseSQSEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('QueueUrl not found in CreateQueue event');
            throw new Error('QueueUrl not found in CreateQueue event');
          }
          break;

        case 'DeleteQueue':
          queueUrl = event.detail.requestParameters?.queueUrl;
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseSQSEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('queueUrl', queueUrl)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteQueue event');
          break;

        case 'TagQueue':
          eventType = 'TagChange';
          queueUrl = event.detail.requestParameters?.queueUrl;
          log
            .info()
            .str('function', 'parseSQSEventAndCreateAlarms')
            .str('eventType', 'TagQueue')
            .str('queueUrl', queueUrl)
            .str('requestId', event.detail.requestID)
            .msg('Processing TagQueue event');
          if (queueUrl) {
            tags = await fetchSQSTags(queueUrl);
            log
              .info()
              .str('function', 'parseSQSEventAndCreateAlarms')
              .str('queueUrl', queueUrl)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new SQS queue');
          } else {
            log
              .error()
              .str('function', 'parseSQSEventAndCreateAlarms')
              .str('eventType', 'TagQueue')
              .msg('QueueUrl not found in TagQueue event');
            throw new Error('Queue not found in TagQueue event');
          }
          break;

        case 'UntagQueue':
          eventType = 'TagChange';
          queueUrl = event.detail.requestParameters?.queueUrl;
          log
            .info()
            .str('function', 'parseSQSEventAndCreateAlarms')
            .str('eventType', 'UntagQueue')
            .str('queueUrl', queueUrl)
            .msg('Processing UntagQueue event');
          if (queueUrl) {
            tags = await fetchSQSTags(queueUrl);
            log
              .info()
              .str('function', 'parseSQSEventAndCreateAlarms')
              .str('queueUrl', queueUrl)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new SQS queue');
          } else {
            log
              .error()
              .str('function', 'parseSQSEventAndCreateAlarms')
              .str('eventType', 'UnTagQueue')
              .msg('QueueUrl not found in TagQueue event');
            throw new Error('Queue not found in TagQueue event');
          }
          break;

        default:
          log
            .error()
            .str('function', 'parseSQSEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
          throw new Error('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .error()
        .str('function', 'parseSQSEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
      throw new Error('Unexpected event type');
  }

  const queueName = extractQueueName(queueUrl);
  if (!queueName) {
    log
      .error()
      .str('function', 'parseSQSEventAndCreateAlarms')
      .str('queueUrl', queueUrl)
      .msg('Extracted queue name is empty');
    throw new Error('Extracted queue name is empty');
  }

  log
    .info()
    .str('function', 'parseSQSEventAndCreateAlarms')
    .str('queueUrl', queueUrl)
    .str('eventType', eventType)
    .msg('Finished processing SQS event');

  if (queueUrl && (eventType === 'Create' || eventType === 'TagChange')) {
    log
      .info()
      .str('function', 'parseSQSEventAndCreateAlarms')
      .str('queueUrl', queueUrl)
      .msg('Starting to manage SQS alarms');
    await manageSQSAlarms(queueName, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseSQSEventAndCreateAlarms')
      .str('queueUrl', queueUrl)
      .msg('Starting to manage inactive SQS alarms');
    await manageInactiveSQSAlarms(queueUrl);
  }

  return {queueUrl, eventType, tags};
}
