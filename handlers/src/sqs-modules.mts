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
import {
  MetricAlarmConfigs,
  parseMetricAlarmOptions,
  MetricAlarmOptions,
} from './alarm-config.mjs';

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
const metricConfigs = MetricAlarmConfigs['SQS'];
const extendedStatRegex = /^p.*|^tm.*|^tc.*|^ts.*|^wm.*|^IQM$/;

function getTagDefaults(
  config: (typeof metricConfigs)[number],
  tagValue: string,
): MetricAlarmOptions {
  return parseMetricAlarmOptions(tagValue, config.defaults);
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

    if (!config.defaultCreate && tagValue === undefined) {
      log
        .info()
        .obj('config', config)
        .msg('Not default and tag value is undefined, skipping.');
      continue; // not a default and not overridden
    }

    const defaults = getTagDefaults(config, tagValue || '');
    log
      .trace()
      .str('function', 'checkAndManageSQSStatusAlarms')
      .str('tagValue', tagValue)
      .str('defaults', JSON.stringify(defaults))
      .unknown('criticalThreshold', defaults.criticalThreshold)
      .unknown('warningThreshold', defaults.warningThreshold)
      .num('evaluationPeriods', defaults.evaluationPeriods)
      .msg('Tag values after processing');
    if (config.anomaly) {
      const alarmNamePrefix = `AutoAlarm-SQS-${queueName}-${config.metricName}-Anomaly`;
      if (defaults.statistic) {
        // Create critical alarm
        if (defaults.statistic !== '-' && defaults.statistic !== 'disabled') {
          try {
            // Create anomaly detector with the latest parameters
            const anomalyDetectorInput = {
              Namespace: config.metricNamespace,
              MetricName: config.metricName,
              Dimensions: [
                {
                  Name: 'QueueName',
                  Value: queueName,
                },
              ],
              Stat: defaults.statistic,
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
            log
              .trace()
              .unknown('warningThreshold', defaults.warningThreshold)
              .unknown('criticalThreshold', defaults.criticalThreshold)
              .msg('Confirming values for warning and critical thresholds');
            if (defaults.warningThreshold) {
              const warningAlarmInput = {
                AlarmName: `${alarmNamePrefix}-Warning`,
                ComparisonOperator:
                  ComparisonOperator.GreaterThanUpperThreshold,
                EvaluationPeriods: defaults.evaluationPeriods,
                Metrics: [
                  {
                    Id: 'primaryMetric',
                    MetricStat: {
                      Metric: {
                        Namespace: config.metricNamespace,
                        MetricName: config.metricName,
                        Dimensions: [
                          {
                            Name: 'QueueName',
                            Value: queueName,
                          },
                        ],
                      },
                      Period: defaults.period,
                      Stat: defaults.statistic,
                    },
                  },
                  {
                    Id: 'anomalyDetectionBand',
                    Expression: 'ANOMALY_DETECTION_BAND(primaryMetric)',
                  },
                ],
                ThresholdMetricId: 'anomalyDetectionBand',
                ActionsEnabled: false,
                Tags: [{Key: 'severity', Value: AlarmClassification.Warning}],
                TreatMissingData: defaults.missingDataTreatment,
              };
              await cloudWatchClient.send(
                new PutMetricAlarmCommand(warningAlarmInput),
              );
            } else if (await doesAlarmExist(`${alarmNamePrefix}-Warning`)) {
              await cloudWatchClient.send(
                new DeleteAlarmsCommand({
                  AlarmNames: [`${alarmNamePrefix}-Warning`],
                }),
              );
            }
            // Create the critical level anomaly detection alarm
            if (defaults.criticalThreshold) {
              const criticalAlarmInput = {
                AlarmName: `${alarmNamePrefix}-Critical`,
                ComparisonOperator:
                  ComparisonOperator.GreaterThanUpperThreshold,
                EvaluationPeriods: defaults.evaluationPeriods,
                Metrics: [
                  {
                    Id: 'primaryMetric',
                    MetricStat: {
                      Metric: {
                        Namespace: config.metricNamespace,
                        MetricName: config.metricName,
                        Dimensions: [
                          {
                            Name: 'QueueName',
                            Value: queueName,
                          },
                        ],
                      },
                      Period: defaults.period,
                      Stat: defaults.statistic,
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
                TreatMissingData: defaults.missingDataTreatment,
              };
              await cloudWatchClient.send(
                new PutMetricAlarmCommand(criticalAlarmInput),
              );
            }
            log
              .info()
              .str('function', 'createOrUpdateAnomalyAlarms')
              .msg('Anomaly Detection Alarms created or updated.');
          } catch (e) {
            log
              .error()
              .str('function', 'createOrUpdateAnomalyAlarms')
              .err(e)
              .msg('Failed to create or update anomaly detection alarms.');
          }
        } else if (await doesAlarmExist(`${alarmNamePrefix}-Critical`)) {
          await cloudWatchClient.send(
            new DeleteAlarmsCommand({
              AlarmNames: [`${alarmNamePrefix}-Critical`],
            }),
          );
        }
      }
    } else {
      const alarmNamePrefix = `AutoAlarm-SQS-${queueName}-${config.metricName}`;
      // Create warning alarm
      if (defaults.warningThreshold) {
        log
          .trace()
          .str('function', 'createOrUpdateAnomalyAlarms')
          .str('tagValue', tagValue)
          .num('warningThreshold', defaults.warningThreshold)
          .num('evaluationPeriods', defaults.evaluationPeriods)
          .msg('Values before creating warning alarm');

        await cloudWatchClient.send(
          new PutMetricAlarmCommand({
            AlarmName: `${alarmNamePrefix}-Warning`,
            ComparisonOperator: 'GreaterThanThreshold',
            EvaluationPeriods: defaults.evaluationPeriods,
            MetricName: config.metricName,
            Namespace: config.metricNamespace,
            Period: defaults.period,
            ...(extendedStatRegex.test(defaults.statistic)
              ? {ExtendedStatistic: defaults.statistic}
              : {Statistic: defaults.statistic as Statistic}),
            Threshold: defaults.warningThreshold,
            ActionsEnabled: false,
            Dimensions: [{Name: 'QueueName', Value: queueName}],
            Tags: [{Key: 'severity', Value: AlarmClassification.Warning}],
            TreatMissingData: defaults.missingDataTreatment,
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
      if (defaults.criticalThreshold) {
        log
          .trace()
          .str('function', 'createOrUpdateAnomalyAlarms')
          .str('tagValue', tagValue)
          .msg('Creating critical alarm');
        await cloudWatchClient.send(
          new PutMetricAlarmCommand({
            AlarmName: `${alarmNamePrefix}-Critical`,
            ComparisonOperator: 'GreaterThanThreshold',
            EvaluationPeriods: defaults.evaluationPeriods,
            MetricName: config.metricName,
            Namespace: config.metricNamespace,
            Period: defaults.period,
            ...(extendedStatRegex.test(defaults.statistic)
              ? {ExtendedStatistic: defaults.statistic}
              : {Statistic: defaults.statistic as Statistic}),
            Threshold: defaults.criticalThreshold,
            ActionsEnabled: false,
            Dimensions: [{Name: 'QueueName', Value: queueName}],
            Tags: [{Key: 'severity', Value: AlarmClassification.Critical}],
            TreatMissingData: defaults.missingDataTreatment,
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
