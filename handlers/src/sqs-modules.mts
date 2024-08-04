import {SQSClient, ListQueueTagsCommand} from '@aws-sdk/client-sqs';
import * as logging from '@nr1e/logging';
import {Tag} from './types.mjs';
import {AlarmClassification} from './enums.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {
  getCWAlarmsForInstance,
  deleteCWAlarm,
  doesAlarmExist,
} from './alarm-tools.mjs';
import {
  CloudWatchClient,
  ComparisonOperator,
  DeleteAlarmsCommand,
  PutAnomalyDetectorCommand,
  PutMetricAlarmCommand,
  Statistic,
} from '@aws-sdk/client-cloudwatch';

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

type MetricConfig = {
  tagKey: string;
  metricName: string;
  namespace: string;
  isDefault: boolean;
  anomaly: boolean;
  defaultValue: string;
};

const metricConfigs: MetricConfig[] = [
  {
    tagKey: 'sqs-age-of-oldest-message',
    metricName: 'ApproximateAgeOfOldestMessage',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/300/1/Maximum',
  },
  {
    tagKey: 'sqs-age-of-oldest-message-anomaly',
    metricName: 'ApproximateAgeOfOldestMessage',
    namespace: 'AWS/SQS',
    isDefault: true,
    anomaly: true,
    defaultValue: 'Maximum/300/1',
  },
  {
    tagKey: 'sqs-number-of-messages-delayed',
    metricName: 'ApproximateNumberOfMessagesDelayed',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/300/1/Maximum',
  },
  {
    tagKey: 'sqs-number-of-messages-delayed-anomaly',
    metricName: 'ApproximateNumberOfMessagesDelayed',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: true,
    defaultValue: 'Maximum/300/1',
  },
  {
    tagKey: 'sqs-number-of-messages-not-visible',
    metricName: 'ApproximateNumberOfMessagesNotVisible',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/300/1/Maximum',
  },
  {
    tagKey: 'sqs-number-of-messages-not-visible-anomaly',
    metricName: 'ApproximateNumberOfMessagesNotVisible',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: true,
    defaultValue: 'Maximum/300/1',
  },
  {
    tagKey: 'sqs-number-of-messages-visible',
    metricName: 'ApproximateNumberOfMessagesVisible',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/300/1/Maximum',
  },
  {
    tagKey: 'sqs-number-of-messages-visible-anomaly',
    metricName: 'ApproximateNumberOfMessagesVisible',
    namespace: 'AWS/SQS',
    isDefault: true,
    anomaly: true,
    defaultValue: 'Maximum/300/1',
  },
  {
    tagKey: 'sqs-number-of-empty-receives',
    metricName: 'NumberOfEmptyReceive',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/300/1/Sum',
  },
  {
    tagKey: 'sqs-number-of-empty-receives-anomaly',
    metricName: 'NumberOfEmptyReceive',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: true,
    defaultValue: 'Sum/300/1',
  },
  {
    tagKey: 'sqs-number-of-messages-deleted',
    metricName: 'NumberOfMessagesDeleted',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/300/1/Sum',
  },
  {
    tagKey: 'sqs-number-of-messages-deleted-anomaly',
    metricName: 'NumberOfMessagesDeleted',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: true,
    defaultValue: 'Sum/300/1',
  },
  {
    tagKey: 'sqs-number-of-messages-received',
    metricName: 'NumberOfMessagesReceived',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/300/1/Sum',
  },
  {
    tagKey: 'sqs-number-of-messages-received-anomaly',
    metricName: 'NumberOfMessagesReceived',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: true,
    defaultValue: 'Sum/300/1',
  },
  {
    tagKey: 'sqs-number-of-messages-sent',
    metricName: 'NumberOfMessagesSent',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/300/1/Sum',
  },
  {
    tagKey: 'sqs-number-of-messages-sent-anomaly',
    metricName: 'NumberOfMessagesSent',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: true,
    defaultValue: 'Sum/300/1',
  },
  {
    tagKey: 'sqs-sent-message-size',
    metricName: 'SentMessageSize',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/300/1/Average',
  },
  {
    tagKey: 'sqs-sent-message-size-anomaly',
    metricName: 'SentMessageSize',
    namespace: 'AWS/SQS',
    isDefault: false,
    anomaly: true,
    defaultValue: 'Average/300/1',
  },
];

type TagDefaults = {
  warning: number | undefined;
  critical: number | undefined;
  stat: string;
  duration: number;
  periods: number;
};

function getTagDefaults(config: MetricConfig, tagValue: string): TagDefaults {
  const parts = tagValue ? tagValue.split('/') : [];
  const defaultParts = config.defaultValue.split('/');
  const defaults = defaultParts.map((defaultValue, index) => {
    if (parts.length > index) {
      if (parts[index] !== '') {
        return parts[index];
      }
    }
    return defaultValue;
  });
  if (config.anomaly) {
    // Take the default value which we know is good
    let duration = Number.parseInt(defaultParts[1]);
    try {
      // Override the default if it's a valid number
      duration = Number.parseInt(defaults[1]);
    } catch (err) {
      // do nothing
    }
    // Take the default value which we know is good
    let periods = Number.parseInt(defaultParts[2]);
    try {
      // Override the default is it's a valid number
      periods = Number.parseInt(defaults[2]);
    } catch (err) {
      // do nothing
    }
    return {
      warning: undefined,
      critical: undefined,
      stat: defaults[0],
      duration,
      periods,
    };
  } else {
    let warning = undefined;
    try {
      // If we can't parse the number, we won't create the alarm and it remains undefined
      warning = Number.parseInt(defaults[0]);
    } catch (err) {
      // do nothing
    }
    let critical = undefined;
    try {
      // If we can't parse the number, we won't create the alarm and it remains undefined
      critical = Number.parseInt(defaults[1]);
    } catch (err) {
      // do nothing
    }
    let duration = Number.parseInt(defaultParts[2]);
    try {
      // If we can't parse the number, we won't create the alarm and it remains undefined
      duration = Number.parseInt(defaults[2]);
    } catch (err) {
      // do nothing
    }
    let periods = Number.parseInt(defaultParts[3]);
    try {
      // If we can't parse the number, we won't create the alarm and it remains undefined
      periods = Number.parseInt(defaults[3]);
    } catch (err) {
      // do nothing
    }
    return {
      warning,
      critical,
      duration,
      periods,
      stat: defaults[4],
    };
  }
}

const extendedStatRegex = /^p.*|^tm.*|^tc.*|^ts.*|^wm.*|^IQM$/;

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

async function checkAndManageSQSStatusAlarms(queueName: string, tags: Tag) {
  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';

  if (!isAlarmEnabled) {
    const activeAutoAlarms = await getCWAlarmsForInstance('SQS', queueName);
    await Promise.all(
      activeAutoAlarms.map((alarmName) => deleteCWAlarm(alarmName, queueName)),
    );
    log.info().msg('Status check alarm creation skipped due to tag settings.');
    return;
  }

  // Check and manage alarms for each metric configuration
  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageSQSStatusAlarms')
      .obj('config', config)
      .str('QueueName', queueName)
      .msg('Tag values before processing');

    const tagValue = tags[`autoalarm:${config.tagKey}`];

    if (!config.isDefault && tagValue === undefined) {
      log
        .info()
        .obj('config', config)
        .msg('Not default and tag value is undefined, skipping.');
      continue; // not a default and not overridden
    }

    const defaults = getTagDefaults(config, tagValue);
    if (config.anomaly) {
      const alarmName = `AutoAlarm-SQS-${queueName}-${config.metricName}-Anomaly-Critical`;
      if (defaults.stat) {
        // Create critical alarm
        if (defaults.stat !== '-' && defaults.stat !== 'disabled') {
          try {
            // Create anomaly detector with the latest parameters
            const anomalyDetectorInput = {
              Namespace: config.namespace,
              MetricName: config.metricName,
              Dimensions: [
                {
                  Name: 'QueueName',
                  Value: queueName,
                },
              ],
              Stat: defaults.stat,
              Configuration: {
                MetricTimezone: 'UTC',
              },
            };
            log
              .debug()
              .obj('input', anomalyDetectorInput)
              .msg('Sending PutAnomalyDetectorCommand');
            await cloudWatchClient.send(
              new PutAnomalyDetectorCommand(anomalyDetectorInput),
            );

            // Create anomaly detection alarm
            const metricAlarmInput = {
              AlarmName: alarmName,
              ComparisonOperator: ComparisonOperator.GreaterThanUpperThreshold,
              EvaluationPeriods: defaults.periods,
              Metrics: [
                {
                  Id: 'primaryMetric',
                  MetricStat: {
                    Metric: {
                      Namespace: config.namespace,
                      MetricName: config.metricName,
                      Dimensions: [
                        {
                          Name: 'QueueName',
                          Value: queueName,
                        },
                      ],
                    },
                    Period: defaults.duration,
                    Stat: defaults.stat,
                  },
                },
                {
                  Id: 'anomalyDetectionBand',
                  Expression: 'ANOMALY_DETECTION_BAND(primaryMetric)',
                },
              ],
              ThresholdMetricId: 'anomalyDetectionBand',
              ActionsEnabled: false,
              Tags: [{Key: 'severity', Value: AlarmClassification.Critical}],
              TreatMissingData: 'ignore', // Adjust as needed
            };
            await cloudWatchClient.send(
              new PutMetricAlarmCommand(metricAlarmInput),
            );

            log
              .info()
              .str('function', 'createOrUpdateAnomalyDetectionAlarm')
              .str('alarmName', alarmName)
              .obj('anomalyDetectorInput', anomalyDetectorInput)
              .obj('metricAlarmInput', metricAlarmInput)
              .msg(`${alarmName} Anomaly Detection Alarm created or updated.`);
          } catch (e) {
            log
              .error()
              .str('function', 'createOrUpdateAnomalyDetectionAlarm')
              .err(e)
              .str('alarmName', alarmName)
              .msg(
                `Failed to create or update ${alarmName} anomaly detection alarm due to an error ${e}`,
              );
          }
        }
      } else if (await doesAlarmExist(alarmName)) {
        await cloudWatchClient.send(
          new DeleteAlarmsCommand({
            AlarmNames: [alarmName],
          }),
        );
      }
    } else {
      const alarmNamePrefix = `AutoAlarm-SQS-${queueName}-${config.metricName}`;
      // Create warning alarm
      if (defaults.warning) {
        await cloudWatchClient.send(
          new PutMetricAlarmCommand({
            AlarmName: `${alarmNamePrefix}-Warning`,
            ComparisonOperator: 'GreaterThanThreshold',
            EvaluationPeriods: defaults.periods,
            MetricName: config.metricName,
            Namespace: config.namespace,
            Period: defaults.duration,
            ...(extendedStatRegex.test(defaults.stat)
              ? {ExtendedStatistic: defaults.stat}
              : {Statistic: defaults.stat as Statistic}),
            Threshold: defaults.warning,
            ActionsEnabled: false,
            Dimensions: [{Name: 'QueueName', Value: queueName}],
            Tags: [{Key: 'severity', Value: 'Warning'}],
            TreatMissingData: 'ignore',
          }),
        );
      } else if (await doesAlarmExist(`${alarmNamePrefix}-Warning`)) {
        await cloudWatchClient.send(
          new DeleteAlarmsCommand({
            AlarmNames: [`${alarmNamePrefix}-Warning`],
          }),
        );
      }

      // Create critical alarm
      if (defaults.critical) {
        await cloudWatchClient.send(
          new PutMetricAlarmCommand({
            AlarmName: `${alarmNamePrefix}-Critical`,
            ComparisonOperator: 'GreaterThanThreshold',
            EvaluationPeriods: defaults.periods,
            MetricName: config.metricName,
            Namespace: config.namespace,
            Period: defaults.duration,
            ...(extendedStatRegex.test(defaults.stat)
              ? {ExtendedStatistic: defaults.stat}
              : {Statistic: defaults.stat as Statistic}),
            Threshold: defaults.critical,
            ActionsEnabled: false,
            Dimensions: [{Name: 'QueueName', Value: queueName}],
            Tags: [{Key: 'severity', Value: 'Critical'}],
            TreatMissingData: 'ignore',
          }),
        );
      } else if (await doesAlarmExist(`${alarmNamePrefix}-Critical`)) {
        await cloudWatchClient.send(
          new DeleteAlarmsCommand({
            AlarmNames: [`${alarmNamePrefix}-Critical`],
          }),
        );
      }
    }
  }
}

export async function manageSQSAlarms(
  queueName: string,
  tags: Tag,
): Promise<void> {
  await checkAndManageSQSStatusAlarms(queueName, tags);
}

export async function manageInactiveSQSAlarms(queueUrl: string) {
  const queueName = extractQueueName(queueUrl);
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'SQS',
      queueName,
    );
    await Promise.all(
      activeAutoAlarms.map((alarmName) => deleteCWAlarm(alarmName, queueName)),
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

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    await manageSQSAlarms(queueName, tags);
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
