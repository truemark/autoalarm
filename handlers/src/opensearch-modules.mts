import {OpenSearchClient, ListTagsCommand} from '@aws-sdk/client-opensearch';
import * as logging from '@nr1e/logging';
import {Tag} from './types.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {AlarmClassification} from './enums.mjs';
import {getCWAlarmsForInstance, deleteCWAlarm} from './alarm-tools.mjs';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  PutAnomalyDetectorCommand,
  PutMetricAlarmCommand,
  MetricDataQuery,
  Statistic,
} from '@aws-sdk/client-cloudwatch';
import {
  MetricAlarmConfigs,
  parseMetricAlarmOptions,
  MetricAlarmConfig,
  MetricAlarmOptions,
} from './alarm-config.mjs';

const log: logging.Logger = logging.getLogger('opensearch-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const openSearchClient: OpenSearchClient = new OpenSearchClient({
  region,
  retryStrategy,
});

const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region: region,
  retryStrategy: retryStrategy,
});

const metricConfigs = MetricAlarmConfigs['OS'];

export async function fetchOpenSearchTags(domainArn: string): Promise<Tag> {
  try {
    const command = new ListTagsCommand({
      ARN: domainArn,
    });
    const response = await openSearchClient.send(command);
    const tags: Tag = {};

    response.TagList?.forEach((tag) => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .info()
      .str('function', 'fetchOpenSearchTags')
      .str('domainArn', domainArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched OpenSearch tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchOpenSearchTags')
      .err(error)
      .str('domainArn', domainArn)
      .msg('Error fetching OpenSearch tags');
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
  domainName: string,
) {
  for (const classification of Object.values(AlarmClassification)) {
    for (const alarmVariant of ['static', 'anomaly'] as const) {
      const alarmName = buildAlarmName(
        config,
        domainName,
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
  domainName: string,
  classification: AlarmClassification,
  alarmVarient: 'anomaly' | 'static',
) {
  const alarmName =
    alarmVarient === 'anomaly'
      ? `AutoAlarm-OS-${domainName}-${config.metricName}-anomaly-${classification}`
      : `AutoAlarm-OS-${domainName}-${config.metricName}-${classification}`;
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
  domainName: string,
  accountID: string,
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
    Dimensions: [
      {Name: 'DomainName', Value: domainName},
      {Name: 'ClientId', Value: accountID},
    ],
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
          Dimensions: [
            {Name: 'DomainName', Value: domainName},
            {Name: 'ClientId', Value: accountID},
          ],
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
  domainName: string,
  accountID: string,
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
    const alarmPrefix = `AutoAlarm-OS-${domainName}-${config.metricName}-anomaly-`;
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('DomainName', domainName)
      .str('ClientId', accountID)
      .str('alarm prefix: ', alarmPrefix)
      .msg(
        'No thresholds defined, skipping alarm creation and deleting alarms for config if they exist.',
      );
    await deleteAlarmsForConfig(config, domainName);
    return createdAlarms;
  }

  // Handle warning anomaly alarm
  if (warningThresholdSet) {
    const warningAlarmName = buildAlarmName(
      config,
      domainName,
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
      domainName,
      accountID,
      AlarmClassification.Warning,
      updatedDefaults.warningThreshold as number,
    );
    createdAlarms.push(warningAlarmName);
  } else {
    const warningAlarmName = buildAlarmName(
      config,
      domainName,
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
      domainName,
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
      domainName,
      accountID,
      AlarmClassification.Critical,
      updatedDefaults.criticalThreshold as number,
    );
    createdAlarms.push(criticalAlarmName);
  } else {
    const criticalAlarmName = buildAlarmName(
      config,
      domainName,
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
  domainName: string,
  accountID: string,
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
      Dimensions: [
        {Name: 'DomainName', Value: domainName},
        {Name: 'ClientId', Value: accountID},
      ],
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
  domainName: string,
  accountID: string,
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
    const alarmPrefix = `AutoAlarm-OS-${domainName}-${config.metricName}`;
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('DomainName', domainName)
      .str('ClientId', accountID)
      .str('alarm prefix: ', `${alarmPrefix}`)
      .msg(
        'No thresholds defined, skipping alarm creation and deleting alarms for config if they exist.',
      );
    await deleteAlarmsForConfig(config, domainName);
    return createdAlarms;
  }

  // Handle warning static alarm
  if (warningThresholdSet) {
    const warningAlarmName = buildAlarmName(
      config,
      domainName,
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
      domainName,
      accountID,
      AlarmClassification.Warning,
      updatedDefaults.warningThreshold as number,
    );
    createdAlarms.push(warningAlarmName);
  } else {
    const warningAlarmName = buildAlarmName(
      config,
      domainName,
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
      domainName,
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
      domainName,
      accountID,
      AlarmClassification.Critical,
      updatedDefaults.criticalThreshold as number,
    );
    createdAlarms.push(criticalAlarmName);
  } else {
    const criticalAlarmName = buildAlarmName(
      config,
      domainName,
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

async function checkAndManageOpenSearchStatusAlarms(
  domainName: string,
  accountID: string,
  tags: Tag,
) {
  log
    .info()
    .str('function', 'checkAndManageOSStatusAlarms')
    .str('DomainName', domainName)
    .str('ClientId', accountID)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageOSStatusAlarms')
      .str('DomainName', domainName)
      .str('ClientId', accountID)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('OS', domainName);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageOSStatusAlarms')
      .obj('config', config)
      .str('DomainName', domainName)
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
          .str('function', 'checkAndManageOSStatusAlarms')
          .str('DomainName', domainName)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          domainName,
          accountID,
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageOSStatusAlarms')
          .str('DomainName', domainName)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          domainName,
          accountID,
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageOSStatusAlarms')
        .str('DomainName', domainName)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            domainName,
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
  const existingAlarms = await getCWAlarmsForInstance('OS', domainName);
  const alarmsToDelete = existingAlarms.filter(
    (alarm) => !alarmsToKeep.has(alarm),
  );

  log
    .info()
    .str('function', 'checkAndManageOSStatusAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarm that is no longer needed');
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageOSStatusAlarms')
    .str('DomainName', domainName)
    .msg('Finished alarm management process');
}

export async function manageOpenSearchAlarms(
  domainName: string,
  accountID: string,
  tags: Tag,
): Promise<void> {
  await checkAndManageOpenSearchStatusAlarms(domainName, accountID, tags);
}

export async function manageInactiveOpenSearchAlarms(domainName: string) {
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'OS',
      domainName,
    );
    await Promise.all(
      activeAutoAlarms.map((alarmName) => deleteCWAlarm(alarmName, domainName)),
    );
  } catch (e) {
    log.error().err(e).msg(`Error deleting OpenSearch alarms: ${e}`);
    throw new Error(`Error deleting OpenSearch alarms: ${e}`);
  }
}

function extractOSDomainNameFromArn(arn: string): string {
  const regex = /domain\/([^/]+)$/;
  const match = arn.match(regex);
  return match ? match[1] : '';
}

function extractAccountIdFromArn(arn: string): string {
  const parts = arn.split(':');
  return parts.length > 4 ? parts[4] : '';
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseOSEventAndCreateAlarms(event: any): Promise<{
  domainArn: string;
  accountID: string;
  eventType: string;
  tags: Record<string, string>;
}> {
  let domainArn: string = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      domainArn = event.resources[0];
      eventType = 'Domain TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseOSEventAndCreateAlarms')
        .str('eventType', eventType)
        .str('domainArn', domainArn)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');
      break;

    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateDomain':
          domainArn = event.detail.responseElements?.domain?.arn;
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseOSEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('domainArn', domainArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateDomain event');
          if (domainArn) {
            tags = await fetchOpenSearchTags(domainArn);
            log
              .info()
              .str('function', 'parseOSEventAndCreateAlarms')
              .str('domainArn', domainArn)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new domain');
          } else {
            log
              .warn()
              .str('function', 'parseOSEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('DomainArn not found in CreateDomain event');
          }
          break;

        case 'DeleteDomain':
          domainArn = event.detail.requestParameters?.domainArn;
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseOSEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('domainArn', domainArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteDomain event');
          break;

        default:
          log
            .warn()
            .str('function', 'parseOSEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .warn()
        .str('function', 'parseOSEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
  }

  const domainName = extractOSDomainNameFromArn(domainArn);
  const accountID = extractAccountIdFromArn(domainArn);
  if (!domainName) {
    log
      .error()
      .str('function', 'parseOSEventAndCreateAlarms')
      .str('domainArn', domainArn)
      .msg('Extracted domain name is empty');
  }

  log
    .info()
    .str('function', 'parseOSEventAndCreateAlarms')
    .str('domainArn', domainArn)
    .str('eventType', eventType)
    .msg('Finished processing domain event');

  if (
    domainArn &&
    (eventType === 'Create' || eventType === 'Domain TagChange')
  ) {
    log
      .info()
      .str('function', 'parseOSEventAndCreateAlarms')
      .str('domainArn', domainArn)
      .msg('Starting to manage domain alarms');
    await manageOpenSearchAlarms(domainName, accountID, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseOSEventAndCreateAlarms')
      .str('domainArn', domainArn)
      .msg('Starting to manage inactive domain alarms');
    await manageInactiveOpenSearchAlarms(domainName);
  }

  return {domainArn, accountID, eventType, tags};
}
