import {SQSClient, ListQueueTagsCommand} from '@aws-sdk/client-sqs';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types.mjs';
import {AlarmClassification} from './enums.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
  createOrUpdateAnomalyDetectionAlarm,
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
  {metricName: 'NumberOfMessagesSent', namespace: 'AWS/SQS'},
];

const defaultThreshold = (type: AlarmClassification) =>
  type === 'Critical' ? 1000 : 500;

// Default values for duration and periods
const defaultStaticDurationTime = 60; // e.g., 300 seconds
const defaultStaticDurationPeriods = 2; // e.g., 5 periods
const defaultAnomalyDurationTime = 60; // e.g., 300 seconds
const defaultAnomalyDurationPeriods = 2; // e.g., 5 periods
const defaultExtendedStatistic: string = 'p90';

async function getSQSAlarmConfig(
  queueName: string,
  type: AlarmClassification,
  metricName: string,
  tags: Tag
): Promise<{
  alarmName: string;
  staticThresholdAlarmName: string;
  anomalyAlarmName: string;
  extendedStatistic: string;
  threshold: number;
  durationStaticTime: number;
  durationStaticPeriods: number;
  durationAnomalyTime: number;
  durationAnomalyPeriods: number;
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
  let extendedStatistic = defaultExtendedStatistic;
  let durationStaticTime = defaultStaticDurationTime;
  let durationStaticPeriods = defaultStaticDurationPeriods;
  let durationAnomalyTime = defaultAnomalyDurationTime;
  let durationAnomalyPeriods = defaultAnomalyDurationPeriods;

  log
    .info()
    .str('function', 'getSQSAlarmConfig')
    .str('queueName', queueName)
    .msg('Fetching alarm configuration');

  // Define tag key based on metric
  let cwTagKey = '';
  let anomalyTagKey = '';

  switch (metricName) {
    case 'ApproximateNumberOfMessagesVisible':
      cwTagKey = 'autoalarm:cw-sqs-messages-visible';
      anomalyTagKey = 'autoalarm:anomaly-sqs-messages-visible';
      break;
    case 'ApproximateAgeOfOldestMessage':
      cwTagKey = 'autoalarm:cw-sqs-oldest-message-age';
      anomalyTagKey = 'autoalarm:anomaly-sqs-oldest-message-age';
      break;
    case 'NumberOfMessagesSent':
      cwTagKey = 'autoalarm:cw-sqs-messages-sent';
      anomalyTagKey = 'autoalarm:anomaly-sqs-messages-sent';
      break;
    default:
      log
        .warn()
        .str('function', 'getSQSAlarmConfig')
        .str('metricName', metricName)
        .msg('Unexpected metric name');
  }

  log
    .info()
    .str('function', 'getSQSAlarmConfig')
    .str('queueName', queueName)
    .str('tags', JSON.stringify(tags))
    .str('cwTagKey', cwTagKey)
    .str('cwTagValue', tags[cwTagKey])
    .str('anomalyTagKey', anomalyTagKey)
    .str('anomalyTagValue', tags[anomalyTagKey])
    .msg('Fetched instance tags');

  // Extract and parse the static threshold tag values
  if (tags[cwTagKey]) {
    const staticValues = tags[cwTagKey].split('/');
    log
      .warn()
      .str('function', 'getSQSAlarmConfig')
      .str('queueName', queueName)
      .str('cwTagKey', cwTagKey)
      .str('cwTagValue', tags[cwTagKey])
      .str('staticValues', JSON.stringify(staticValues))
      .msg('Fetched Static Threshold tag values');

    if (staticValues.length < 1 || staticValues.length > 4) {
      log
        .warn()
        .str('function', 'getSQSAlarmConfig')
        .str('queueName', queueName)
        .str('cwTagKey', cwTagKey)
        .str('cwTagValue', tags[cwTagKey])
        .msg(
          'Invalid tag values/delimiters. Please use 4 values separated by a "/". Using default values'
        );
    } else {
      switch (type) {
        case 'Warning':
          threshold =
            staticValues[0] !== undefined &&
            staticValues[0] !== '' &&
            !isNaN(parseInt(staticValues[0], 10))
              ? parseInt(staticValues[0], 10)
              : defaultThreshold(type);
          durationStaticTime =
            staticValues[2] !== undefined &&
            staticValues[2] !== '' &&
            !isNaN(parseInt(staticValues[2], 10))
              ? parseInt(staticValues[2], 10)
              : defaultStaticDurationTime;
          durationStaticPeriods =
            staticValues[3] !== undefined &&
            staticValues[3] !== '' &&
            !isNaN(parseInt(staticValues[3], 10))
              ? parseInt(staticValues[3], 10)
              : defaultStaticDurationPeriods;
          break;
        case 'Critical':
          threshold =
            staticValues[1] !== undefined &&
            staticValues[1] !== '' &&
            !isNaN(parseInt(staticValues[1], 10))
              ? parseInt(staticValues[1], 10)
              : defaultThreshold(type);
          durationStaticTime =
            staticValues[2] !== undefined &&
            staticValues[2] !== '' &&
            !isNaN(parseInt(staticValues[2], 10))
              ? parseInt(staticValues[2], 10)
              : defaultStaticDurationTime;
          durationStaticPeriods =
            staticValues[3] !== undefined &&
            staticValues[3] !== '' &&
            !isNaN(parseInt(staticValues[3], 10))
              ? parseInt(staticValues[3], 10)
              : defaultStaticDurationPeriods;
          break;
      }
    }
  }

  // Extract and parse the anomaly detection tag values
  if (tags[anomalyTagKey]) {
    const values = tags[anomalyTagKey].split('/');
    const extendedStatRegex = /^\(p\d{1,2}\)$/;
    if (!extendedStatRegex.test(values[0].trim())) {
      log
        .warn()
        .str('function', 'getSQSAlarmConfig')
        .str('queueName', queueName)
        .str('tagKey', anomalyTagKey)
        .str('tagValue', tags[anomalyTagKey])
        .msg(
          "Invalid extended statistic value. Please use a valid percentile value. Using default value of 'p90'"
        );
      values[0] = defaultExtendedStatistic;
    }
    log
      .info()
      .str('function', 'getSQSAlarmConfig')
      .str('queueName', queueName)
      .str('anomalyTagKey', anomalyTagKey)
      .str('anomalyTagValue', tags[anomalyTagKey])
      .str('values', JSON.stringify(values))
      .msg('Fetched Anomaly Detection tag values');

    if (values.length < 1 || values.length > 3) {
      log
        .warn()
        .str('function', 'getSQSAlarmConfig')
        .str('queueName', queueName)
        .str('anomalyTagKey', anomalyTagKey)
        .str('anomalyTagValue', tags[anomalyTagKey])
        .msg(
          'Invalid tag values/delimiters. Please use 3 values separated by a "/". Using default values'
        );
    } else {
      extendedStatistic =
        typeof values[0] === 'string' && values[0].trim() !== ''
          ? values[0].trim()
          : defaultExtendedStatistic;
      durationAnomalyTime =
        values[1] !== undefined &&
        values[1] !== '' &&
        !isNaN(parseInt(values[1], 10))
          ? parseInt(values[1], 10)
          : defaultAnomalyDurationTime;
      durationAnomalyPeriods =
        values[2] !== undefined &&
        values[2] !== '' &&
        !isNaN(parseInt(values[2], 10))
          ? parseInt(values[2], 10)
          : defaultAnomalyDurationPeriods;
      log
        .info()
        .str('function', 'getSQSAlarmConfig')
        .str('queueName', queueName)
        .str('anomalyTagKey', anomalyTagKey)
        .str('anomalyTagValue', tags[anomalyTagKey])
        .str('extendedStatistic', extendedStatistic)
        .num('durationTime', durationAnomalyTime)
        .num('durationPeriods', durationAnomalyPeriods)
        .msg('Fetched Anomaly Detection tag values');
    }
  }
  log
    .info()
    .str('function', 'getSQSAlarmConfig')
    .str('queueName', queueName)
    .str('type', type)
    .str('metric', metricName)
    .str(
      'staticThresholdAlarmName',
      `AutoAlarm-SQS-${queueName}-${type}-${metricName.toUpperCase()}`
    )
    .str(
      'anomalyAlarmName',
      `AutoAlarm-SQS-${queueName}-Critical-${metricName.toUpperCase()}`
    )
    .str('extendedStatistic', extendedStatistic)
    .num('threshold', threshold)
    .num('durationStaticTime', durationStaticTime)
    .num('durationStaticPeriods', durationStaticPeriods)
    .num('durationAnomalyTime', durationAnomalyTime)
    .num('durationAnomalyPeriods', durationAnomalyPeriods)
    .msg('Fetched alarm configuration');
  return {
    alarmName: `AutoAlarm-SQS-${queueName}-${type}-${metricName.toUpperCase()}`,
    staticThresholdAlarmName: `AutoAlarm-SQS-StaticThreshold-${queueName}-${type}-${metricName.toUpperCase()}`,
    anomalyAlarmName: `AutoAlarm-SQS-AnomalyDetection-${queueName}-Critical-${metricName.toUpperCase()}`,
    extendedStatistic,
    threshold,
    durationStaticTime,
    durationStaticPeriods,
    durationAnomalyTime,
    durationAnomalyPeriods,
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
      let cwTagKey = '';
      let anomalyTagKey = '';
      switch (metricName) {
        case 'ApproximateNumberOfMessagesVisible':
          cwTagKey = 'autoalarm:cw-sqs-messages-visible';
          anomalyTagKey = 'autoalarm:anomaly-sqs-messages-visible';
          break;
        case 'ApproximateAgeOfOldestMessage':
          cwTagKey = 'autoalarm:cw-sqs-oldest-message-age';
          anomalyTagKey = 'autoalarm:anomaly-sqs-oldest-message-age';
          break;
        case 'NumberOfMessagesSent':
          cwTagKey = 'autoalarm:cw-sqs-messages-sent';
          anomalyTagKey = 'autoalarm:anomaly-sqs-messages-sent';
          break;
        default:
          log
            .warn()
            .str('function', 'getSQSAlarmConfig')
            .str('metricName', metricName)
            .msg('Unexpected metric name');
      }

      log
        .info()
        .str('function', 'checkAndManageSQSStatusAlarms')
        .str('queueName', queueName)
        .str('cwTagKey', cwTagKey)
        .str('cwTagValue', tags[cwTagKey] || 'undefined')
        .str('anomalyTagKey', anomalyTagKey)
        .str('anomalyTagValue', tags[anomalyTagKey] || 'undefined')
        .msg('Tag values before processing');

      for (const type of ['Warning', 'Critical'] as AlarmClassification[]) {
        const {
          staticThresholdAlarmName,
          anomalyAlarmName,
          extendedStatistic,
          threshold,
          durationStaticTime,
          durationStaticPeriods,
          durationAnomalyTime,
          durationAnomalyPeriods,
        } = await getSQSAlarmConfig(queueName, type, metricName, tags);

        // Create or update anomaly detection alarm
        await createOrUpdateAnomalyDetectionAlarm(
          anomalyAlarmName,
          'SQS',
          queueName,
          metricName,
          namespace,
          extendedStatistic,
          durationAnomalyTime,
          durationAnomalyPeriods,
          'Critical' as AlarmClassification
        );

        // Check and create or delete static threshold alarm based on tag values
        if (
          type === 'Warning' &&
          (!tags[cwTagKey] ||
            tags[cwTagKey].split('/')[0] === undefined ||
            tags[cwTagKey].split('/')[0] === '' ||
            !tags[cwTagKey].split('/')[0])
        ) {
          log
            .info()
            .str('function', 'checkAndManageSQSStatusAlarms')
            .str('queueName', queueName)
            .str(cwTagKey, tags[cwTagKey])
            .msg(
              `SQS alarm threshold for ${metricName} Warning is not defined. Skipping static ${metricName} Warning alarm creation.`
            );
          await deleteCWAlarm(staticThresholdAlarmName, queueName);
        } else if (
          type === 'Critical' &&
          (!tags[cwTagKey] ||
            tags[cwTagKey].split('/')[1] === '' ||
            tags[cwTagKey].split('/')[1] === undefined ||
            !tags[cwTagKey].split('/')[1])
        ) {
          log
            .info()
            .str('function', 'checkAndManageSQSStatusAlarms')
            .str('queueName', queueName)
            .str(cwTagKey, tags[cwTagKey])
            .msg(
              `SQS alarm threshold for ${metricName} Critical is not defined. Skipping static ${metricName} Critical alarm creation.`
            );
          await deleteCWAlarm(staticThresholdAlarmName, queueName);
        } else {
          const alarmProps: AlarmProps = {
            threshold: threshold,
            period: 60,
            namespace: namespace,
            evaluationPeriods: 5,
            metricName: metricName,
            dimensions: [{Name: 'QueueName', Value: queueName}],
          };

          await createOrUpdateCWAlarm(
            staticThresholdAlarmName,
            queueName,
            alarmProps,
            threshold,
            durationStaticTime,
            durationStaticPeriods,
            'Maximum',
            //@ts-ignore
            type as AlarmClassification
          );
        }
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
              .warn()
              .str('function', 'parseSQSEventAndCreateAlarms')
              .str('eventType', 'TagQueue')
              .msg('QueueUrl not found in TagQueue event');
          }
          break;

        case 'UntagQueue':
          eventType = 'RemoveTag';
          queueUrl = event.detail.requestParameters?.queueUrl;
          log
            .info()
            .str('function', 'parseSQSEventAndCreateAlarms')
            .str('eventType', 'UntagQueue')
            .str('queueUrl', queueUrl)
            .str('tags', JSON.stringify(event.detail.requestParameters?.tags))
            .msg('Processing UntagQueue event');
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
  } else if (eventType === 'Delete' || eventType === 'RemoveTag') {
    log
      .info()
      .str('function', 'parseSQSEventAndCreateAlarms')
      .str('queueUrl', queueUrl)
      .msg('Starting to manage inactive SQS alarms');
    await manageInactiveSQSAlarms(queueUrl);
  }

  return {queueUrl, eventType, tags};
}
