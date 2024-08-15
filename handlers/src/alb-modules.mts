import {
  DescribeTagsCommand,
  ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import * as logging from '@nr1e/logging';
import {Tag} from './types.mjs';
import {AlarmClassification} from './enums.mjs';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  PutAnomalyDetectorCommand,
  PutMetricAlarmCommand,
  MetricDataQuery,
  Statistic,
} from '@aws-sdk/client-cloudwatch';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {deleteCWAlarm, getCWAlarmsForInstance} from './alarm-tools.mjs';
import {
  MetricAlarmConfigs,
  parseMetricAlarmOptions,
  MetricAlarmConfig,
  MetricAlarmOptions,
} from './alarm-config.mjs';

const log: logging.Logger = logging.getLogger('alb-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const elbClient: ElasticLoadBalancingV2Client =
  new ElasticLoadBalancingV2Client({
    region,
    retryStrategy,
  });
const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region: region,
  retryStrategy: retryStrategy,
});

const metricConfigs = MetricAlarmConfigs['ALB'];
// used to match extended statistics in alarm creation
const extendedStatRegex = /^p.*|^tm.*|^tc.*|^ts.*|^wm.*|^iqm$/;

export async function fetchALBTags(loadBalancerArn: string): Promise<Tag> {
  try {
    const command = new DescribeTagsCommand({
      ResourceArns: [loadBalancerArn],
    });
    const response = await elbClient.send(command);
    const tags: Tag = {};

    response.TagDescriptions?.forEach((tagDescription) => {
      tagDescription.Tags?.forEach((tag) => {
        if (tag.Key && tag.Value) {
          tags[tag.Key] = tag.Value;
        }
      });
    });

    log
      .info()
      .str('function', 'fetchALBTags')
      .str('loadBalancerArn', loadBalancerArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched ALB tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchALBTags')
      .err(error)
      .str('loadBalancerArn', loadBalancerArn)
      .msg('Error fetching ALB tags');
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
  loadBalancerName: string,
) {
  for (const classification of Object.values(AlarmClassification)) {
    for (const alarmVariant of ['static', 'anomaly'] as const) {
      const alarmName = buildAlarmName(
        config,
        loadBalancerName,
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
  loadBalancerName: string,
  classification: AlarmClassification,
  alarmVarient: 'anomaly' | 'static',
) {
  const alarmName =
    alarmVarient === 'anomaly'
      ? `AutoAlarm-ALB-${loadBalancerName}-${config.metricName}-anomaly-${classification}`
      : `AutoAlarm-ALB-${loadBalancerName}-${config.metricName}-${classification}`;
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
  loadBalancerName: string,
  classification: AlarmClassification,
) {
  log
    .info()
    .str('function', 'handleAnomalyDetectionWorkflow')
    .str('AlarmName', alarmName)
    .msg('Handling anomaly detection alarm workflow');

  const anomalyDetectorInput = {
    Namespace: config.metricNamespace,
    MetricName: config.metricName,
    Dimensions: [{Name: 'LoadBalancer', Value: loadBalancerName}],
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
          Dimensions: [{Name: 'LoadBalancer', Value: loadBalancerName}],
        },
        Period: updatedDefaults.period,
        Stat: updatedDefaults.statistic,
      },
    },
    {
      Id: 'anomalyDetectionBand',
      Expression: `ANOMALY_DETECTION_BAND(primaryMetric, ${updatedDefaults.warningThreshold})`,
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
  loadBalancerName: string,
  updatedDefaults: MetricAlarmOptions,
) {
  if (
    updatedDefaults.warningThreshold !== undefined ||
    updatedDefaults.criticalThreshold !== null
  ) {
    const warningAlarmName = buildAlarmName(
      config,
      loadBalancerName,
      AlarmClassification.Warning,
      'anomaly',
    );
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('AlarmName', warningAlarmName)
      .msg('Creating or updating warning anomaly alarms');
    await createOrUpdateAlarm(
      warningAlarmName,
      updatedDefaults,
      config,
      loadBalancerName,
      AlarmClassification.Warning,
      config.anomaly,
    );
  } else {
    const warningAlarmName = buildAlarmName(
      config,
      loadBalancerName,
      AlarmClassification.Warning,
      'anomaly',
    );
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('AlarmName', warningAlarmName)
      .msg(
        'No warning anomaly threshold defined and not a default alarm. Deleting existing warning anomaly alarm.',
      );
    await deleteAlarm(warningAlarmName);
  }
  if (
    updatedDefaults.criticalThreshold !== undefined ||
    updatedDefaults.criticalThreshold !== null
  ) {
    const criticalAlarmName = buildAlarmName(
      config,
      loadBalancerName,
      AlarmClassification.Critical,
      'anomaly',
    );
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('AlarmName', criticalAlarmName)
      .msg('Creating or updating critical anomaly alarms');
    await createOrUpdateAlarm(
      criticalAlarmName,
      updatedDefaults,
      config,
      loadBalancerName,
      AlarmClassification.Critical,
      config.anomaly,
    );
  } else {
    const criticalAlarmName = buildAlarmName(
      config,
      loadBalancerName,
      AlarmClassification.Critical,
      'anomaly',
    );
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .obj('alarm config', config)
      .msg(
        'No critical anomaly threshold defined and not a default alarm. Deleting existing critical anomaly alarm.',
      );
    await deleteAlarm(criticalAlarmName);
  }
}

async function handleStaticThresholdWorkflow(
  alarmName: string,
  updatedDefaults: MetricAlarmOptions,
  config: MetricAlarmConfig,
  loadBalancerName: string,
  classification: AlarmClassification,
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
      ...(extendedStatRegex.test(updatedDefaults.statistic)
        ? {ExtendedStatistic: updatedDefaults.statistic}
        : {Statistic: updatedDefaults.statistic as Statistic}),
      Threshold: updatedDefaults.warningThreshold as number,
      ActionsEnabled: false,
      Dimensions: [{Name: 'LoadBalancer', Value: loadBalancerName}],
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
  loadBalancerName: string,
  updatedDefaults: MetricAlarmOptions,
) {
  // Handle warning static alarm
  if (
    updatedDefaults.warningThreshold !== undefined ||
    updatedDefaults.criticalThreshold !== null
  ) {
    const warningAlarmName = buildAlarmName(
      config,
      loadBalancerName,
      AlarmClassification.Warning,
      'static',
    );
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('AlarmName', warningAlarmName)
      .msg('Creating or updating warning static alarms');
    await createOrUpdateAlarm(
      warningAlarmName,
      updatedDefaults,
      config,
      loadBalancerName,
      AlarmClassification.Warning,
      config.anomaly, // This remains false for static alarms
    );
  } else {
    const warningAlarmName = buildAlarmName(
      config,
      loadBalancerName,
      AlarmClassification.Warning,
      'static',
    );
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('AlarmName', warningAlarmName)
      .msg(
        'No warning static threshold defined and not a default alarm. Deleting existing warning static alarm.',
      );
    await deleteAlarm(warningAlarmName);
  }

  // Handle critical static alarm
  if (
    updatedDefaults.criticalThreshold !== undefined ||
    updatedDefaults.criticalThreshold !== null
  ) {
    const criticalAlarmName = buildAlarmName(
      config,
      loadBalancerName,
      AlarmClassification.Critical,
      'static',
    );
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('AlarmName', criticalAlarmName)
      .msg('Creating or updating critical static alarms');
    await createOrUpdateAlarm(
      criticalAlarmName,
      updatedDefaults,
      config,
      loadBalancerName,
      AlarmClassification.Critical,
      config.anomaly, // This remains false for static alarms
    );
  } else {
    const criticalAlarmName = buildAlarmName(
      config,
      loadBalancerName,
      AlarmClassification.Critical,
      'static',
    );
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .obj('alarm config', config)
      .msg(
        'No critical static threshold defined and not a default alarm. Deleting existing critical static alarm.',
      );
    await deleteAlarm(criticalAlarmName);
  }
}

async function createOrUpdateAlarm(
  alarmName: string,
  updatedDefaults: MetricAlarmOptions,
  config: MetricAlarmConfig,
  loadBalancerName: string,
  classification: AlarmClassification,
  isAnomaly: boolean,
) {
  log
    .info()
    .str('function', 'createOrUpdateAlarm')
    .str('AlarmName', alarmName)
    .bool('isAnomaly', isAnomaly)
    .msg('Creating or updating alarm');

  try {
    if (isAnomaly) {
      await handleAnomalyDetectionWorkflow(
        alarmName,
        updatedDefaults,
        config,
        loadBalancerName,
        classification,
      );
    } else {
      await handleStaticThresholdWorkflow(
        alarmName,
        updatedDefaults,
        config,
        loadBalancerName,
        classification,
      );
    }

    log
      .info()
      .str('function', 'createOrUpdateAlarm')
      .str('AlarmName', alarmName)
      .msg('Successfully created or updated alarm');
  } catch (e) {
    log
      .error()
      .str('function', 'createOrUpdateAlarm')
      .str('AlarmName', alarmName)
      .err(e)
      .msg('Error creating or updating alarm');
  }
}

async function checkAndManageALBStatusAlarms(
  loadBalancerName: string,
  tags: Tag,
) {
  log
    .info()
    .str('function', 'checkAndManageALBStatusAlarms')
    .str('LoadBalancerName', loadBalancerName)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageALBStatusAlarms')
      .str('LoadBalancerName', loadBalancerName)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('ALB', loadBalancerName);
    return;
  }

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageALBStatusAlarms')
      .obj('config', config)
      .str('LoadBalancerName', loadBalancerName)
      .msg('Processing metric configuration');

    const tagValue = tags[`autoalarm:${config.tagKey}`];
    const updatedDefaults = parseMetricAlarmOptions(
      tagValue || '',
      config.defaults,
    );

    // If alarm creation is not default and no tag value is present, delete existing alarms
    if (!config.defaultCreate && tagValue === undefined) {
      log
        .info()
        .str('function', 'checkAndManageALBStatusAlarms')
        .msg('No default or overridden alarm. Deleting existing alarms.');
      await deleteAlarmsForConfig(config, loadBalancerName);
      continue;
    }

    // Handle anomaly and static alarms
    if (config.tagKey.includes('anomaly')) {
      log
        .info()
        .str('function', 'checkAndManageALBStatusAlarms')
        .str('LoadBalancerName', loadBalancerName)
        .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
      await handleAnomalyAlarms(config, loadBalancerName, updatedDefaults);
    } else {
      log
        .info()
        .str('function', 'checkAndManageALBStatusAlarms')
        .str('LoadBalancerName', loadBalancerName)
        .msg('Tag key indicates static alarm. Handling static alarms');
      await handleStaticAlarms(config, loadBalancerName, updatedDefaults);
    }
  }

  log
    .info()
    .str('function', 'checkAndManageALBStatusAlarms')
    .str('LoadBalancerName', loadBalancerName)
    .msg('Finished alarm management process');
}

export async function manageALBAlarms(
  loadBalancerName: string,
  tags: Tag,
): Promise<void> {
  await checkAndManageALBStatusAlarms(loadBalancerName, tags);
}

export async function manageInactiveALBAlarms(loadBalancerName: string) {
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'ALB',
      loadBalancerName,
    );
    await Promise.all(
      activeAutoAlarms.map((alarmName) =>
        deleteCWAlarm(alarmName, loadBalancerName),
      ),
    );
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveALBAlarms')
      .err(e)
      .msg(`Error deleting ALB alarms: ${e}`);
    throw new Error(`Error deleting ALB alarms: ${e}`);
  }
}

function extractAlbNameFromArn(arn: string): string {
  const regex = /\/app\/(.*?\/[^/]+)$/;
  const match = arn.match(regex);
  return match ? `app/${match[1]}` : '';
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseALBEventAndCreateAlarms(event: any): Promise<{
  loadBalancerArn: string;
  eventType: string;
  tags: Record<string, string>;
}> {
  let loadBalancerArn: string = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      loadBalancerArn = event.resources[0];
      eventType = 'TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseALBEventAndCreateAlarms')
        .str('eventType', 'TagChange')
        .str('loadBalancerArn', loadBalancerArn)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');
      break;

    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateLoadBalancer':
          loadBalancerArn =
            event.detail.responseElements?.loadBalancers[0]?.loadBalancerArn;
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseALBEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('loadBalancerArn', loadBalancerArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateLoadBalancer event');
          if (loadBalancerArn) {
            tags = await fetchALBTags(loadBalancerArn);
            log
              .info()
              .str('function', 'parseALBEventAndCreateAlarms')
              .str('loadBalancerArn', loadBalancerArn)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new ALB');
          } else {
            log
              .warn()
              .str('function', 'parseALBEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('LoadBalancerArn not found in CreateLoadBalancer event');
          }
          break;

        case 'DeleteLoadBalancer':
          loadBalancerArn = event.detail.requestParameters?.loadBalancerArn;
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseALBEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('loadBalancerArn', loadBalancerArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteLoadBalancer event');
          break;

        default:
          log
            .warn()
            .str('function', 'parseALBEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .warn()
        .str('function', 'parseALBEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
  }

  const loadbalancerName = extractAlbNameFromArn(loadBalancerArn);
  if (!loadbalancerName) {
    log
      .error()
      .str('function', 'parseALBEventAndCreateAlarms')
      .str('loadBalancerArn', loadBalancerArn)
      .msg('Extracted load balancer name is empty');
  }

  log
    .info()
    .str('function', 'parseALBEventAndCreateAlarms')
    .str('loadBalancerArn', loadBalancerArn)
    .str('eventType', eventType)
    .msg('Finished processing ALB event');

  if (
    loadBalancerArn &&
    (eventType === 'Create' || eventType === 'TagChange')
  ) {
    log
      .info()
      .str('function', 'parseALBEventAndCreateAlarms')
      .str('loadBalancerArn', loadBalancerArn)
      .msg('Starting to manage ALB alarms');
    await manageALBAlarms(loadbalancerName, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseALBEventAndCreateAlarms')
      .str('loadBalancerArn', loadBalancerArn)
      .msg('Starting to manage inactive ALB alarms');
    await manageInactiveALBAlarms(loadbalancerName);
  }

  return {loadBalancerArn, eventType, tags};
}
