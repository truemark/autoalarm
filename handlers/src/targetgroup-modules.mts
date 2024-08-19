import {
  ElasticLoadBalancingV2Client,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import * as logging from '@nr1e/logging';
import {Tag} from './types.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  PutAnomalyDetectorCommand,
  PutMetricAlarmCommand,
  MetricDataQuery,
  Statistic,
} from '@aws-sdk/client-cloudwatch';
import {AlarmClassification} from './enums.mjs';
import {deleteCWAlarm, getCWAlarmsForInstance} from './alarm-tools.mjs';
import * as arnparser from '@aws-sdk/util-arn-parser';
import {
  MetricAlarmConfigs,
  parseMetricAlarmOptions,
  MetricAlarmConfig,
  MetricAlarmOptions,
} from './alarm-config.mjs';

const log: logging.Logger = logging.getLogger('targetgroup-modules');
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

const metricConfigs = MetricAlarmConfigs['TG'];

export async function fetchTGTags(targetGroupArn: string): Promise<Tag> {
  try {
    const command = new DescribeTagsCommand({
      ResourceArns: [targetGroupArn],
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
      .str('function', 'fetchTGTags')
      .str('targetGroupArn', targetGroupArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched target group tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchTGTags')
      .err(error)
      .str('targetGroupArn', targetGroupArn)
      .msg('Error fetching target group tags');
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
  targetGroupName: string,
) {
  for (const classification of Object.values(AlarmClassification)) {
    for (const alarmVariant of ['static', 'anomaly'] as const) {
      const alarmName = buildAlarmName(
        config,
        targetGroupName,
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
  targetGroupName: string,
  classification: AlarmClassification,
  alarmVarient: 'anomaly' | 'static',
) {
  const alarmName =
    alarmVarient === 'anomaly'
      ? `AutoAlarm-TG-${targetGroupName}-${config.metricName}-anomaly-${classification}`
      : `AutoAlarm-TG-${targetGroupName}-${config.metricName}-${classification}`;
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
  targetGroupName: string,
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
      {Name: 'TargetGroup', Value: targetGroupName},
      {Name: 'LoadBalancer', Value: loadBalancerName},
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
            {Name: 'TargetGroup', Value: targetGroupName},
            {Name: 'LoadBalancer', Value: loadBalancerName},
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
  loadBalancerName: string,
  targetGroupName: string,
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
    const alarmPrefix = `AutoAlarm-TG-${targetGroupName}-${config.metricName}-anomaly-`;
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('TargetGroupName', targetGroupName)
      .str('LoadBalancerName', loadBalancerName)
      .str('alarm prefix: ', alarmPrefix)
      .msg(
        'No thresholds defined, skipping alarm creation and deleting alarms for config if they exist.',
      );
    await deleteAlarmsForConfig(config, targetGroupName);
    return createdAlarms;
  }

  // Handle warning anomaly alarm
  if (warningThresholdSet) {
    const warningAlarmName = buildAlarmName(
      config,
      targetGroupName,
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
      loadBalancerName,
      targetGroupName,
      AlarmClassification.Warning,
      updatedDefaults.warningThreshold as number,
    );
    createdAlarms.push(warningAlarmName);
  } else {
    const warningAlarmName = buildAlarmName(
      config,
      targetGroupName,
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
      targetGroupName,
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
      loadBalancerName,
      targetGroupName,
      AlarmClassification.Critical,
      updatedDefaults.criticalThreshold as number,
    );
    createdAlarms.push(criticalAlarmName);
  } else {
    const criticalAlarmName = buildAlarmName(
      config,
      targetGroupName,
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
  loadBalancerName: string,
  targetGroupName: string,
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
        {Name: 'TargetGroup', Value: targetGroupName},
        {Name: 'LoadBalancer', Value: loadBalancerName},
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
  loadBalancerName: string,
  targetGroupName: string,
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
    const alarmPrefix = `AutoAlarm-TG-${targetGroupName}-${config.metricName}`;
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('TargetGroupName', targetGroupName)
      .str('LoadBalancerName', loadBalancerName)
      .str('alarm prefix: ', `${alarmPrefix}`)
      .msg(
        'No thresholds defined, skipping alarm creation and deleting alarms for config if they exist.',
      );
    await deleteAlarmsForConfig(config, targetGroupName);
    return createdAlarms;
  }

  // Handle warning static alarm
  if (warningThresholdSet) {
    const warningAlarmName = buildAlarmName(
      config,
      targetGroupName,
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
      targetGroupName,
      loadBalancerName,
      AlarmClassification.Warning,
      updatedDefaults.warningThreshold as number,
    );
    createdAlarms.push(warningAlarmName);
  } else {
    const warningAlarmName = buildAlarmName(
      config,
      targetGroupName,
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
      targetGroupName,
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
      targetGroupName,
      loadBalancerName,
      AlarmClassification.Critical,
      updatedDefaults.criticalThreshold as number,
    );
    createdAlarms.push(criticalAlarmName);
  } else {
    const criticalAlarmName = buildAlarmName(
      config,
      targetGroupName,
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

async function checkAndManageTGStatusAlarms(
  loadBalancerName: string,
  targetGroupName: string,
  tags: Tag,
) {
  log
    .info()
    .str('function', 'checkAndManageTGStatusAlarms')
    .str('TargetGroupName', targetGroupName)
    .str('LoadBalancerName', loadBalancerName)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageTGStatusAlarms')
      .str('TargetGroupName', targetGroupName)
      .str('LoadBalancerName', loadBalancerName)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('TG', targetGroupName);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageTGStatusAlarms')
      .obj('config', config)
      .str('TargetGroupName', targetGroupName)
      .str('LoadBalancerName', loadBalancerName)
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
          .str('function', 'checkAndManageTGStatusAlarms')
          .str('TargetGroupName', targetGroupName)
          .str('LoadBalancerName', loadBalancerName)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          loadBalancerName,
          targetGroupName,
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageTGStatusAlarms')
          .str('TargetGroupName', targetGroupName)
          .str('LoadBalancerName', loadBalancerName)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          targetGroupName,
          loadBalancerName,
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageTGStatusAlarms')
        .str('TargetGroupName', targetGroupName)
        .str('LoadBalancerName', loadBalancerName)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            targetGroupName,
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
  const existingAlarms = await getCWAlarmsForInstance('TG', targetGroupName);
  const alarmsToDelete = existingAlarms.filter(
    (alarm) => !alarmsToKeep.has(alarm),
  );

  log
    .info()
    .str('function', 'checkAndManageTGStatusAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarm that is no longer needed');
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageTGStatusAlarms')
    .str('TargetGroupName', targetGroupName)
    .str('LoadBalancerName', loadBalancerName)
    .msg('Finished alarm management process');
}

export async function manageTGAlarms(
  targetGroupName: string,
  loadBalancerName: string,
  tags: Tag,
): Promise<void> {
  await checkAndManageTGStatusAlarms(targetGroupName, loadBalancerName, tags);
}

export async function manageInactiveTGAlarms(targetGroupName: string) {
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'TG',
      targetGroupName,
    );
    await Promise.all(
      activeAutoAlarms.map((alarmName) =>
        deleteCWAlarm(alarmName, targetGroupName),
      ),
    );
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveTGAlarms')
      .err(e)
      .msg(`Error deleting target group alarms: ${e}`);
    throw new Error(`Error deleting target group alarms: ${e}`);
  }
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseTGEventAndCreateAlarms(event: any): Promise<{
  targetGroupArn: string;
  eventType: string;
  tags: Record<string, string>;
}> {
  let targetGroupArn: string = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      targetGroupArn = event.resources[0];
      eventType = 'Target Group TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseTGEventAndCreateAlarms')
        .str('eventType', eventType)
        .str('targetGroupArn', targetGroupArn)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');
      break;

    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateTargetGroup':
          targetGroupArn =
            event.detail.responseElements?.targetGroups[0]?.targetGroupArn;
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseTGEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('targetGroupArn', targetGroupArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateTargetGroup event');
          if (targetGroupArn) {
            tags = await fetchTGTags(targetGroupArn);
            log
              .info()
              .str('function', 'parseTGEventAndCreateAlarms')
              .str('targetGroupArn', targetGroupArn)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new target group');
          } else {
            log
              .warn()
              .str('function', 'parseTGEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('TargetGroupArn not found in CreateTargetGroup event');
          }
          break;

        case 'DeleteTargetGroup':
          targetGroupArn = event.detail.requestParameters?.targetGroupArn;
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseTGEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('targetGroupArn', targetGroupArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteTargetGroup event');
          break;

        default:
          log
            .warn()
            .str('function', 'parseTGEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .warn()
        .str('function', 'parseTGEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
  }

  const response = await elbClient.send(
    new DescribeTargetGroupsCommand({
      TargetGroupArns: [targetGroupArn],
    }),
  );
  let loadBalancerArn: string | undefined = undefined;
  if (response.TargetGroups && response.TargetGroups.length > 0) {
    const loadBalancerArns = response.TargetGroups[0].LoadBalancerArns;
    if (loadBalancerArns && loadBalancerArns.length > 0) {
      loadBalancerArn = loadBalancerArns[0];
    }
  }
  if (!loadBalancerArn) {
    log
      .error()
      .str('function', 'parseTGEventAndCreateAlarms')
      .str('targetGroupArn', targetGroupArn)
      .msg('Load balancer ARN not found');
    throw new Error('Load balancer ARN not found');
  }
  const lbArn = arnparser.parse(loadBalancerArn);
  const loadBalancerName = lbArn.resource.replace('loadbalancer/', '');
  const arn = arnparser.parse(targetGroupArn);
  const targetGroupName = arn.resource;
  if (!targetGroupName) {
    log
      .error()
      .str('function', 'parseTGEventAndCreateAlarms')
      .str('targetGroupArn', targetGroupArn)
      .msg('Extracted target group name is empty');
  }

  log
    .info()
    .str('function', 'parseTGEventAndCreateAlarms')
    .str('targetGroupArn', targetGroupArn)
    .str('eventType', eventType)
    .msg('Finished processing target group event');

  if (
    targetGroupArn &&
    (eventType === 'Create' || eventType === 'Target Group TagChange')
  ) {
    log
      .info()
      .str('function', 'parseTGEventAndCreateAlarms')
      .str('targetGroupArn', targetGroupArn)
      .msg('Starting to manage target group alarms');
    await manageTGAlarms(targetGroupName, loadBalancerName, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseTGEventAndCreateAlarms')
      .str('targetGroupArn', targetGroupArn)
      .msg('Starting to manage inactive target group alarms');
    await manageInactiveTGAlarms(targetGroupName);
  }

  return {targetGroupArn, eventType, tags};
}
