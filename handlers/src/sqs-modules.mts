import {SQSClient, ListQueueTagsCommand} from '@aws-sdk/client-sqs';
import * as logging from '@nr1e/logging';
import {Tag} from './types.mjs';
import {AlarmClassification} from './enums.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {getCWAlarmsForInstance, deleteCWAlarm} from './alarm-tools.mjs';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  MetricDataQuery,
  PutAnomalyDetectorCommand,
  PutMetricAlarmCommand,
  Statistic,
} from '@aws-sdk/client-cloudwatch';
import {
  MetricAlarmConfigs,
  parseMetricAlarmOptions,
  MetricAlarmConfig,
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

async function deleteExistingAlarms(service: string, identifier: string) {
  log
    .info()
    .str('function', 'deleteExistingAlarms')
    .str('Service', service)
    .str('Identifier', identifier)
    .msg('Fetching and deleting existing alarms');
  const activeAutoAlarms = await getCWAlarmsForInstance(service, identifier);

  log
    .info()
    .str('function', 'deleteExistingAlarms')
    .obj('AlarmName', activeAutoAlarms)
    .msg('Deleting alarm');
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...activeAutoAlarms],
    }),
  );
}

async function deleteAlarmsForConfig(
  config: MetricAlarmConfig,
  queueName: string,
) {
  for (const classification of Object.values(AlarmClassification)) {
    for (const alarmVariant of ['static', 'anomaly'] as const) {
      const alarmName = buildAlarmName(
        config,
        queueName,
        classification,
        alarmVariant,
      );
      await deleteAlarm(alarmName);
    }
  }
}

async function deleteAlarm(alarmName: string) {
  log
    .info()
    .str('function', 'deleteAlarm')
    .str('AlarmName', alarmName)
    .msg('Attempting to delete alarm');
  try {
    await cloudWatchClient.send(
      new DeleteAlarmsCommand({AlarmNames: [alarmName]}),
    );
    log
      .info()
      .str('function', 'deleteAlarm')
      .str('AlarmName', alarmName)
      .msg('Successfully deleted alarm');
  } catch (e) {
    log
      .error()
      .str('function', 'deleteAlarm')
      .str('AlarmName', alarmName)
      .err(e)
      .msg('Error deleting alarm');
  }
}

function buildAlarmName(
  config: MetricAlarmConfig,
  queueName: string,
  classification: AlarmClassification,
  alarmVarient: 'anomaly' | 'static',
) {
  const alarmName =
    alarmVarient === 'anomaly'
      ? `AutoAlarm-SQS-${queueName}-${config.metricName}-anomaly-${classification}`
      : `AutoAlarm-SQS-${queueName}-${config.metricName}-${classification}`;
  log
    .info()
    .str('function', 'buildAlarmName')
    .str('AlarmName', alarmName)
    .msg('Built alarm name name');
  return alarmName;
}

async function handleAnomalyDetectionWorkflow(
  alarmName: string,
  updatedDefaults: MetricAlarmOptions,
  config: MetricAlarmConfig,
  queueName: string,
  classification: AlarmClassification,
  threshold: number,
) {
  log
    .info()
    .str('function', 'handleAnomalyDetectionWorkflow')
    .str('AlarmName', alarmName)
    .msg('Handling anomaly detection alarm workflow');

  const anomalyDetectorInput = {
    Namespace: config.metricNamespace,
    MetricName: config.metricName,
    Dimensions: [{Name: 'QueueName', Value: queueName}],
    Stat: updatedDefaults.statistic,
    Configuration: {MetricTimezone: 'UTC'},
  };

  log
    .debug()
    .str('function', 'handleAnomalyDetectionWorkflow')
    .obj('AnomalyDetectorInput', anomalyDetectorInput)
    .msg('Sending PutAnomalyDetectorCommand');
  const response = await cloudWatchClient.send(
    new PutAnomalyDetectorCommand(anomalyDetectorInput),
  );
  log
    .info()
    .str('function', 'handleAnomalyDetectionWorkflow')
    .str('AlarmName', alarmName)
    .obj('response', response)
    .msg('Successfully created or updated anomaly detector');

  const metrics: MetricDataQuery[] = [
    {
      Id: 'primaryMetric',
      MetricStat: {
        Metric: {
          Namespace: config.metricNamespace,
          MetricName: config.metricName,
          Dimensions: [{Name: 'QueueName', Value: queueName}],
        },
        Period: updatedDefaults.period,
        Stat: updatedDefaults.statistic,
      },
    },
    {
      Id: 'anomalyDetectionBand',
      Expression: `ANOMALY_DETECTION_BAND(primaryMetric, ${threshold})`,
    },
  ];

  try {
    const alarmInput = {
      AlarmName: alarmName,
      ComparisonOperator: updatedDefaults.comparisonOperator,
      EvaluationPeriods: updatedDefaults.evaluationPeriods,
      Metrics: metrics,
      ThresholdMetricId: 'anomalyDetectionBand',
      ActionsEnabled: false,
      Tags: [{Key: 'severity', Value: classification}],
      TreatMissingData: updatedDefaults.missingDataTreatment,
    };

    log
      .info()
      .str('function', 'handleAnomalyDetectionWorkflow')
      .obj('AlarmInput', alarmInput)
      .msg('Sending PutMetricAlarmCommand');

    const response = await cloudWatchClient.send(
      new PutMetricAlarmCommand(alarmInput),
    );
    log
      .info()
      .str('function', 'handleAnomalyDetectionWorkflow')
      .str('AlarmName', alarmName)
      .obj('response', response)
      .msg('Successfully created or updated anomaly detection alarm');
  } catch (e) {
    log
      .error()
      .str('function', 'handleAnomalyDetectionWorkflow')
      .str('AlarmName', alarmName)
      .err(e)
      .msg('Error creating or updating anomaly detection alarm');
  }
}

async function handleAnomalyAlarms(
  config: MetricAlarmConfig,
  queueName: string,
  updatedDefaults: MetricAlarmOptions,
): Promise<string[]> {
  const createdAlarms: string[] = [];

  // Validate if thresholds are set correctly
  const warningThresholdSet =
    updatedDefaults.warningThreshold !== undefined &&
    updatedDefaults.warningThreshold !== null;
  const criticalThresholdSet =
    updatedDefaults.criticalThreshold !== undefined &&
    updatedDefaults.criticalThreshold !== null;

  // If no thresholds are set, log and exit early
  if (!warningThresholdSet && !criticalThresholdSet && !config.defaultCreate) {
    const alarmPrefix = `AutoAlarm-SQS-${queueName}-${config.metricName}-anomaly-`;
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('queueName', queueName)
      .str('alarm prefix: ', alarmPrefix)
      .msg(
        'No thresholds defined, skipping alarm creation and deleting alarms for config if they exist.',
      );
    await deleteAlarmsForConfig(config, queueName);
    return createdAlarms;
  }

  // Handle warning anomaly alarm
  if (warningThresholdSet) {
    const warningAlarmName = buildAlarmName(
      config,
      queueName,
      AlarmClassification.Warning,
      'anomaly',
    );
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('AlarmName', warningAlarmName)
      .msg('Creating or updating warning anomaly alarm');
    await handleAnomalyDetectionWorkflow(
      warningAlarmName,
      updatedDefaults,
      config,
      queueName,
      AlarmClassification.Warning,
      updatedDefaults.warningThreshold as number,
    );
    createdAlarms.push(warningAlarmName);
  } else {
    const warningAlarmName = buildAlarmName(
      config,
      queueName,
      AlarmClassification.Warning,
      'anomaly',
    );
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('AlarmName', warningAlarmName)
      .msg('Deleting existing warning anomaly alarm due to no threshold.');
    await deleteAlarm(warningAlarmName);
  }

  // Handle critical anomaly alarm
  if (criticalThresholdSet) {
    const criticalAlarmName = buildAlarmName(
      config,
      queueName,
      AlarmClassification.Critical,
      'anomaly',
    );
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('AlarmName', criticalAlarmName)
      .msg('Creating or updating critical anomaly alarm');
    await handleAnomalyDetectionWorkflow(
      criticalAlarmName,
      updatedDefaults,
      config,
      queueName,
      AlarmClassification.Critical,
      updatedDefaults.criticalThreshold as number,
    );
    createdAlarms.push(criticalAlarmName);
  } else {
    const criticalAlarmName = buildAlarmName(
      config,
      queueName,
      AlarmClassification.Critical,
      'anomaly',
    );
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('AlarmName', criticalAlarmName)
      .msg('Deleting existing critical anomaly alarm due to no threshold.');
    await deleteAlarm(criticalAlarmName);
  }

  return createdAlarms;
}

async function handleStaticThresholdWorkflow(
  alarmName: string,
  updatedDefaults: MetricAlarmOptions,
  config: MetricAlarmConfig,
  queueName: string,
  classification: AlarmClassification,
  threshold: number,
) {
  log
    .info()
    .str('function', 'handleStaticThresholdWorkflow')
    .str('AlarmName', alarmName)
    .msg('Handling static threshold alarm workflow');

  try {
    const alarmInput = {
      AlarmName: alarmName,
      ComparisonOperator: updatedDefaults.comparisonOperator,
      EvaluationPeriods: updatedDefaults.evaluationPeriods,
      MetricName: config.metricName,
      Namespace: config.metricNamespace,
      Period: updatedDefaults.period,
      ...(['p', 'tm', 'tc', 'ts', 'wm', 'iqm'].some((prefix) =>
        updatedDefaults.statistic.startsWith(prefix),
      )
        ? {ExtendedStatistic: updatedDefaults.statistic}
        : {Statistic: updatedDefaults.statistic as Statistic}),
      Threshold: threshold,
      ActionsEnabled: false,
      Dimensions: [{Name: 'QueueName', Value: queueName}],
      Tags: [{Key: 'severity', Value: classification}],
      TreatMissingData: updatedDefaults.missingDataTreatment,
    };

    log
      .debug()
      .str('function', 'handleStaticThresholdWorkflow')
      .obj('AlarmInput', alarmInput)
      .msg('Sending PutMetricAlarmCommand');
    const response = await cloudWatchClient.send(
      new PutMetricAlarmCommand(alarmInput),
    );
    log
      .info()
      .str('function', 'handleStaticThresholdWorkflow')
      .str('AlarmName', alarmName)
      .obj('response', response)
      .msg('Successfully created or updated static threshold alarm');
  } catch (e) {
    log
      .error()
      .str('function', 'handleStaticThresholdWorkflow')
      .str('AlarmName', alarmName)
      .err(e)
      .msg('Error creating or updating static threshold alarm');
  }
}

async function handleStaticAlarms(
  config: MetricAlarmConfig,
  queueName: string,
  updatedDefaults: MetricAlarmOptions,
): Promise<string[]> {
  const createdAlarms: string[] = [];

  // Validate if thresholds are set correctly
  const warningThresholdSet =
    updatedDefaults.warningThreshold !== undefined &&
    updatedDefaults.warningThreshold !== null;
  const criticalThresholdSet =
    updatedDefaults.criticalThreshold !== undefined &&
    updatedDefaults.criticalThreshold !== null;

  // If no thresholds are set, log and exit early
  if (!warningThresholdSet && !criticalThresholdSet && !config.defaultCreate) {
    const alarmPrefix = `AutoAlarm-SQS-${queueName}-${config.metricName}`;
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('QueueName', queueName)
      .str('alarm prefix: ', `${alarmPrefix}`)
      .msg(
        'No thresholds defined, skipping alarm creation and deleting alarms for config if they exist.',
      );
    await deleteAlarmsForConfig(config, queueName);
    return createdAlarms;
  }

  // Handle warning static alarm
  if (warningThresholdSet) {
    const warningAlarmName = buildAlarmName(
      config,
      queueName,
      AlarmClassification.Warning,
      'static',
    );
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('AlarmName', warningAlarmName)
      .msg('Creating or updating warning static alarms');
    await handleStaticThresholdWorkflow(
      warningAlarmName,
      updatedDefaults,
      config,
      queueName,
      AlarmClassification.Warning,
      updatedDefaults.warningThreshold as number,
    );
    createdAlarms.push(warningAlarmName);
  } else {
    const warningAlarmName = buildAlarmName(
      config,
      queueName,
      AlarmClassification.Warning,
      'static',
    );
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('AlarmName', warningAlarmName)
      .msg('Deleting existing warning static alarm due to no threshold.');
    await deleteAlarm(warningAlarmName);
  }

  // Handle critical static alarm
  if (criticalThresholdSet) {
    const criticalAlarmName = buildAlarmName(
      config,
      queueName,
      AlarmClassification.Critical,
      'static',
    );
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('AlarmName', criticalAlarmName)
      .msg('Creating or updating critical static alarms');
    await handleStaticThresholdWorkflow(
      criticalAlarmName,
      updatedDefaults,
      config,
      queueName,
      AlarmClassification.Critical,
      updatedDefaults.criticalThreshold as number,
    );
    createdAlarms.push(criticalAlarmName);
  } else {
    const criticalAlarmName = buildAlarmName(
      config,
      queueName,
      AlarmClassification.Critical,
      'static',
    );
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('AlarmName', criticalAlarmName)
      .msg('Deleting existing critical static alarm due to no threshold.');
    await deleteAlarm(criticalAlarmName);
  }

  return createdAlarms;
}

async function checkAndManageSQSStatusAlarms(queueName: string, tags: Tag) {
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
          queueName,
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
          queueName,
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
