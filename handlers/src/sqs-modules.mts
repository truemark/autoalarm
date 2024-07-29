import {SQSClient, ListQueueTagsCommand} from '@aws-sdk/client-sqs';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types.mjs';
import {AlarmClassification} from './enums.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
} from './alarm-tools.mjs';

const log: logging.Logger = logging.getLogger('sqs-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const sqsClient: SQSClient = new SQSClient({
  region,
  retryStrategy,
});

const metricConfigs = [
  {metricName: 'ApproximateNumberOfMessagesVisible', namespace: 'AWS/SQS'},
  {metricName: 'ApproximateAgeOfOldestMessage', namespace: 'AWS/SQS'},
];

const defaultThreshold = (type: AlarmClassification) =>
  type === 'CRITICAL' ? 1000 : 500;

// Default values for duration and periods
const defaultDurationTime = 60; // e.g., 300 seconds
const defaultDurationPeriods = 2; // e.g., 5 periods

async function getSQSAlarmConfig(
  queueName: string,
  type: AlarmClassification,
  metricName: string,
  tags: Tag
): Promise<{
  alarmName: string;
  threshold: number;
  durationTime: number;
  durationPeriods: number;
}> {
  log
    .info()
    .str('function', 'getSQSAlarmConfig')
    .str('queueName', queueName)
    .str('type', type)
    .str('metric', metricName)
    .msg('Fetching alarm configuration');

  // Initialize variables with default values
  let threshold = defaultThreshold(type);
  let durationTime = defaultDurationTime;
  let durationPeriods = defaultDurationPeriods;

  // Define tag key based on metric
  const tagKey = `autoalarm:${metricName}`;

  log
    .info()
    .str('function', 'getSQSAlarmConfig')
    .str('queueName', queueName)
    .str('tags', JSON.stringify(tags))
    .str('tagKey', tagKey)
    .str('tagValue', tags[tagKey])
    .msg('Fetched queue tags');

  // Extract and parse the tag value
  if (tags[tagKey]) {
    const values = tags[tagKey].split('|');
    if (values.length < 1 || values.length > 4) {
      log
        .warn()
        .str('function', 'getSQSAlarmConfig')
        .str('queueName', queueName)
        .str('tagKey', tagKey)
        .str('tagValue', tags[tagKey])
        .msg(
          'Invalid tag values/delimiters. Please use 4 values separated by a "|". Using default values'
        );
    } else {
      switch (type) {
        case 'WARNING':
          threshold = !isNaN(parseInt(values[0]))
            ? parseInt(values[0], 10)
            : defaultThreshold(type);
          durationTime = !isNaN(parseInt(values[2]))
            ? parseInt(values[2], 10)
            : defaultDurationTime;
          durationPeriods = !isNaN(parseInt(values[3]))
            ? parseInt(values[3], 10)
            : defaultDurationPeriods;
          break;
        case 'CRITICAL':
          threshold = !isNaN(parseInt(values[1]))
            ? parseInt(values[1], 10)
            : defaultThreshold(type);
          durationTime = !isNaN(parseInt(values[2]))
            ? parseInt(values[2], 10)
            : defaultDurationTime;
          durationPeriods = !isNaN(parseInt(values[3]))
            ? parseInt(values[3], 10)
            : defaultDurationPeriods;
          break;
      }
    }
  }
  return {
    alarmName: `AutoAlarm-SQS-${queueName}-${type}-${metricName.toUpperCase()}`,
    threshold,
    durationTime,
    durationPeriods,
  };
}

export async function fetchSQSTags(queueUrl: string): Promise<Tag> {
  try {
    const command = new ListQueueTagsCommand({QueueUrl: queueUrl});
    const response = await sqsClient.send(command);
    const tags: Tag = response.Tags || {};

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

async function checkAndManageSQSStatusAlarms(queueUrl: string, tags: Tag) {
  const queueName = extractQueueName(queueUrl);
  if (tags['autoalarm:enabled'] === 'false' || !tags['autoalarm:enabled']) {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'SQS',
      queueName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName => deleteCWAlarm(alarmName, queueName))
    );
    log.info().msg('Status check alarm creation skipped due to tag settings.');
  } else if (tags['autoalarm:enabled'] === undefined) {
    log
      .info()
      .msg(
        'Status check alarm creation skipped due to missing autoalarm:enabled tag.'
      );
    return;
  } else {
    for (const config of metricConfigs) {
      const {metricName, namespace} = config;
      for (const classification of Object.values(AlarmClassification)) {
        const {alarmName, threshold, durationTime, durationPeriods} =
          await getSQSAlarmConfig(
            queueName,
            classification as AlarmClassification,
            metricName,
            tags
          );

        const alarmProps: AlarmProps = {
          threshold: threshold,
          period: 60,
          namespace: namespace,
          evaluationPeriods: 5,
          metricName: metricName,
          dimensions: [{Name: 'QueueName', Value: queueName}],
        };

        await createOrUpdateCWAlarm(
          alarmName,
          queueName,
          alarmProps,
          threshold,
          durationTime,
          durationPeriods,
          'Maximum',
          classification
        );
      }
    }
  }
}

export async function manageSQSAlarms(
  queueUrl: string,
  tags: Tag
): Promise<void> {
  await checkAndManageSQSStatusAlarms(queueUrl, tags);
}

export async function manageInactiveSQSAlarms(queueUrl: string) {
  const queueName = extractQueueName(queueUrl);
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'SQS',
      queueName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName => deleteCWAlarm(alarmName, queueName))
    );
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
  return parts[parts.length - 1];
}

export async function parseSQSEventAndCreateAlarms(event: any): Promise<{
  queueUrl: string;
  eventType: string;
  tags: Record<string, string>;
}> {
  let queueUrl: string = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      queueUrl = event.resources[0];
      eventType = 'TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseSQSEventAndCreateAlarms')
        .str('eventType', 'TagChange')
        .str('queueUrl', queueUrl)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');
      break;

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
              .warn()
              .str('function', 'parseSQSEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('QueueUrl not found in CreateQueue event');
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

        default:
          log
            .warn()
            .str('function', 'parseSQSEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
      }
      break;

    case 'TagQueue':
      log
        .info()
        .str('function', 'parseSQSEventAndCreateAlarms')
        .str('eventType', 'TagQueue')
        .str('queueUrl', event.detail.requestParameters.queueUrl)
        .str('tags', JSON.stringify(event.detail.requestParameters.tags))
        .msg('Processing TagQueue event');
      break;

    case 'UntagQueue':
      log
        .info()
        .str('function', 'parseSQSEventAndCreateAlarms')
        .str('eventType', 'UntagQueue')
        .str('queueUrl', event.detail.requestParameters.queueUrl)
        .str('tags', JSON.stringify(event.detail.requestParameters.tags))
        .msg('Processing UntagQueue event');
      break;

    default:
      log
        .warn()
        .str('function', 'parseSQSEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
  }

  const queueName = extractQueueName(queueUrl);
  if (!queueName) {
    log
      .error()
      .str('function', 'parseSQSEventAndCreateAlarms')
      .str('queueUrl', queueUrl)
      .msg('Extracted queue name is empty');
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
    await manageSQSAlarms(queueUrl, tags);
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
