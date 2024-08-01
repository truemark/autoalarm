import {
  ElasticLoadBalancingV2Client,
  DescribeTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {AlarmClassification} from './enums.mjs';
import {
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
  createOrUpdateAnomalyDetectionAlarm,
} from './alarm-tools.mjs';

const log: logging.Logger = logging.getLogger('targetgroup-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const elbClient: ElasticLoadBalancingV2Client =
  new ElasticLoadBalancingV2Client({
    region,
    retryStrategy,
  });

const getDefaultThreshold = (
  metricName: string,
  type: AlarmClassification
): number => {
  if (metricName === 'UnHealthyHostCount') {
    return type === 'CRITICAL' ? 2 : 1;
  } else if (metricName === 'TargetResponseTime') {
    return type === 'CRITICAL' ? 3 : 2;
  } else {
    return type === 'CRITICAL' ? 1500 : 1000; // Default threshold for other metrics
  }
};

// Default values for duration and periods
const defaultStaticDurationTime = 60; // e.g., 300 seconds
const defaultStaticDurationPeriods = 2; // e.g., 5 periods
const defaultAnomalyDurationTime = 60; // e.g., 300 seconds
const defaultAnomalyDurationPeriods = 2; // e.g., 5 periods
const defaultExtendedStatistic: string = 'p90';

const metricConfigs = [
  {metricName: 'UnHealthyHostCount', namespace: 'AWS/ApplicationELB'},
  {metricName: 'TargetResponseTime', namespace: 'AWS/ApplicationELB'},
  {metricName: 'RequestCountPerTarget', namespace: 'AWS/ApplicationELB'},
  {metricName: 'HTTPCode_Target_4XX_Count', namespace: 'AWS/ApplicationELB'},
  {metricName: 'HTTPCode_Target_5XX_Count', namespace: 'AWS/ApplicationELB'},
];

async function getTGAlarmConfig(
  targetGroupName: string,
  type: AlarmClassification,
  service: string,
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
    .str('function', 'getTGAlarmConfig')
    .str('TargetGroupName', targetGroupName)
    .str('type', type)
    .str('metric', metricName)
    .msg('Fetching alarm configuration');

  // Initialize variables with default values
  let threshold = getDefaultThreshold(metricName, type);
  let extendedStatistic = defaultExtendedStatistic;
  let durationStaticTime = defaultStaticDurationTime;
  let durationStaticPeriods = defaultStaticDurationPeriods;
  let durationAnomalyTime = defaultAnomalyDurationTime;
  let durationAnomalyPeriods = defaultAnomalyDurationPeriods;

  log
    .info()
    .str('function', 'getTGAlarmConfig')
    .str('TargetGroupName', targetGroupName)
    .msg('Fetching alarm configuration');

  // Define tag key based on metric
  let cwTagKey = '';
  let anomalyTagKey = '';

  switch (metricName) {
    case 'UnHealthyHostCount':
      cwTagKey = 'autoalarm:cw-tg-unhealthy-host-count';
      anomalyTagKey = 'autoalarm:anomaly-tg-unhealthy-host-count';
      break;
    case 'TargetResponseTime':
      cwTagKey = 'autoalarm:cw-tg-response-time';
      anomalyTagKey = 'autoalarm:anomaly-tg-response-time';
      break;
    case 'RequestCountPerTarget':
      cwTagKey = 'autoalarm:cw-tg-request-count';
      anomalyTagKey = 'autoalarm:anomaly-tg-request-count';
      break;
    case 'HTTPCode_Target_4XX_Count':
      cwTagKey = 'autoalarm:cw-tg-4xx-count';
      anomalyTagKey = 'autoalarm:anomaly-tg-4xx-count';
      break;
    case 'HTTPCode_Target_5XX_Count':
      cwTagKey = 'autoalarm:cw-tg-5xx-count';
      anomalyTagKey = 'autoalarm:anomaly-tg-5xx-count';
      break;
    default:
      log
        .warn()
        .str('function', 'getTGAlarmConfig')
        .str('TargetGroupName', targetGroupName)
        .str('metricName', metricName)
        .msg('Invalid metric name');
      break;
  }
  log
    .info()
    .str('function', 'getTGAlarmConfig')
    .str('TargetGroupName', targetGroupName)
    .str('tags', JSON.stringify(tags))
    .str('cwTagKey', cwTagKey)
    .str('cwTagValue', tags[cwTagKey])
    .str('anomalyTagKey', anomalyTagKey)
    .str('anomalyTagValue', tags[anomalyTagKey])
    .msg('Fetched instance tags');

  // Extract and parse the tag value
  if (tags[cwTagKey]) {
    const staticValues = tags[cwTagKey].split('/');
    log
      .info()
      .str('function', 'getTGAlarmConfig')
      .str('TargetGroupName', targetGroupName)
      .str('tagKey', cwTagKey)
      .str('tagValue', tags[cwTagKey])
      .str('staticValues', JSON.stringify(staticValues))
      .msg('Fetched static threshold tag values');

    if (staticValues.length < 1 || staticValues.length > 4) {
      log
        .warn()
        .str('function', 'getTGAlarmConfig')
        .str('TargetGroupName', targetGroupName)
        .str('tagKey', cwTagKey)
        .str('tagValue', tags[cwTagKey])
        .msg(
          'Invalid tag values/delimiters. Please use 4 values separated by a "/". Using default values'
        );
    } else {
      switch (type) {
        case 'WARNING':
          threshold =
            staticValues[0] !== undefined &&
            staticValues[0] !== '' &&
            !isNaN(parseInt(staticValues[0], 10))
              ? parseInt(staticValues[0], 10)
              : getDefaultThreshold(metricName, type);
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
        case 'CRITICAL':
          threshold =
            staticValues[1] !== undefined &&
            staticValues[1] !== '' &&
            !isNaN(parseInt(staticValues[1], 10))
              ? parseInt(staticValues[1], 10)
              : getDefaultThreshold(metricName, type);
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

  // Extract and parse the anomaly detection tag value
  if (tags[anomalyTagKey]) {
    const values = tags[anomalyTagKey].split('/');
    const extendedStatRegex = /^\(p\d{1,2}\)$/;
    if (!extendedStatRegex.test(values[0].trim())) {
      log
        .warn()
        .str('function', 'getTGAlarmConfig')
        .str('TargetGroupName', targetGroupName)
        .str('tagKey', anomalyTagKey)
        .str('tagValue', tags[anomalyTagKey])
        .msg(
          "Invalid extended statistic value. Please use a valid percentile value. Using default value of 'p90'"
        );
      values[0] = defaultExtendedStatistic;
    }
    log
      .info()
      .str('function', 'getTGAlarmConfig')
      .str('TargetGroupName', targetGroupName)
      .str('tagKey', anomalyTagKey)
      .str('tagValue', tags[anomalyTagKey])
      .str('values', JSON.stringify(values))
      .msg('Fetched anomaly detection tag values');
    if (values.length < 1 || values.length > 3) {
      log
        .warn()
        .str('function', 'getTGAlarmConfig')
        .str('TargetGroupName', targetGroupName)
        .str('tagKey', anomalyTagKey)
        .str('tagValue', tags[anomalyTagKey])
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
        .str('function', 'getTGAlarmConfig')
        .str('TargetGroupName', targetGroupName)
        .str('tagKey', anomalyTagKey)
        .str('tagValue', tags[anomalyTagKey])
        .str('extendedStatistic', extendedStatistic)
        .num('durationAnomalyTime', durationAnomalyTime)
        .num('durationAnomalyPeriods', durationAnomalyPeriods)
        .msg('Parsed anomaly detection tag values');
    }
  }
  log
    .info()
    .str('function', 'getTGAlarmConfig')
    .str('TargetGroupName', targetGroupName)
    .str('type', type)
    .str('metric', metricName)
    .str(
      'staticThresholdAlarmName',
      `AutoAlarm-TG-StaticThreshold - ${targetGroupName} - ${type} - ${metricName.toUpperCase()} `
    )
    .str(
      'anomalyAlarmName',
      `AutoAlarm-TG-AnomalyDetection - ${targetGroupName} - CRITICAL - ${metricName.toUpperCase()} `
    )
    .str('extendedStatistic', extendedStatistic)
    .num('threshold', threshold)
    .num('durationStaticTime', durationStaticTime)
    .num('durationStaticPeriods', durationStaticPeriods)
    .num('durationAnomalyTime', durationAnomalyTime)
    .num('durationAnomalyPeriods', durationAnomalyPeriods)
    .msg('Fetched alarm configuration');
  return {
    alarmName: `AutoAlarm-${service.toUpperCase()}-${targetGroupName}-${type}-${metricName.toUpperCase()}`,
    staticThresholdAlarmName: `AutoAlarm-TG-StaticThreshold-${targetGroupName}-${type}-${metricName.toUpperCase()}`,
    anomalyAlarmName: `AutoAlarm-TG-AnomalyDetection-${targetGroupName}-CRITICAL-${metricName.toUpperCase()}`,
    extendedStatistic,
    threshold,
    durationStaticTime,
    durationStaticPeriods,
    durationAnomalyTime,
    durationAnomalyPeriods,
  };
}

export async function fetchTGTags(targetGroupArn: string): Promise<Tag> {
  try {
    const command = new DescribeTagsCommand({
      ResourceArns: [targetGroupArn],
    });
    const response = await elbClient.send(command);
    const tags: Tag = {};

    response.TagDescriptions?.forEach(tagDescription => {
      tagDescription.Tags?.forEach(tag => {
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

async function checkAndManageTGStatusAlarms(
  targetGroupName: string,
  tags: Tag
) {
  if (tags['autoalarm:enabled'] === 'false' || !tags['autoalarm:enabled']) {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'TG',
      targetGroupName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName =>
        deleteCWAlarm(alarmName, targetGroupName)
      )
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
        case 'UnHealthyHostCount':
          cwTagKey = 'autoalarm:cw-tg-unhealthy-host-count';
          anomalyTagKey = 'autoalarm:anomaly-tg-unhealthy-host-count';
          break;
        case 'TargetResponseTime':
          cwTagKey = 'autoalarm:cw-tg-response-time';
          anomalyTagKey = 'autoalarm:anomaly-tg-response-time';
          break;
        case 'RequestCountPerTarget':
          cwTagKey = 'autoalarm:cw-tg-request-count';
          anomalyTagKey = 'autoalarm:anomaly-tg-request-count';
          break;
        case 'HTTPCode_Target_4XX_Count':
          cwTagKey = 'autoalarm:cw-tg-4xx-count';
          anomalyTagKey = 'autoalarm:anomaly-tg-4xx-count';
          break;
        case 'HTTPCode_Target_5XX_Count':
          cwTagKey = 'autoalarm:cw-tg-5xx-count';
          anomalyTagKey = 'autoalarm:anomaly-tg-5xx-count';
          break;
        default:
          log
            .warn()
            .str('function', 'checkAndManageTGStatusAlarms')
            .str('TargetGroupName', targetGroupName)
            .str('metricName', metricName)
            .msg('Invalid metric name');
          break;
      }

      log
        .info()
        .str('function', 'checkAndManageTGStatusAlarms')
        .str('TargetGroupName', targetGroupName)
        .str('cwTagKey', cwTagKey)
        .str('cwTagValue', tags[cwTagKey] || 'undefined')
        .str('anomalyTagKey', anomalyTagKey)
        .str('anomalyTagValue', tags[anomalyTagKey] || 'undefined')
        .msg('Tag values before processing');

      for (const type of ['WARNING', 'CRITICAL'] as AlarmClassification[]) {
        const {
          staticThresholdAlarmName,
          anomalyAlarmName,
          extendedStatistic,
          threshold,
          durationStaticTime,
          durationStaticPeriods,
          durationAnomalyTime,
          durationAnomalyPeriods,
        } = await getTGAlarmConfig(
          targetGroupName,
          type,
          'tg',
          metricName,
          tags
        );
        await createOrUpdateAnomalyDetectionAlarm(
          anomalyAlarmName,
          'TargetGroup',
          targetGroupName,
          metricName,
          namespace,
          extendedStatistic,
          durationAnomalyTime,
          durationAnomalyPeriods,
          'CRITICAL' as AlarmClassification
        );
        // Check and create or delete static threshold alarm based on tag values
        if (
          type === 'WARNING' &&
          (!tags[cwTagKey] ||
            tags[cwTagKey].split('/')[0] === undefined ||
            tags[cwTagKey].split('/')[0] === '' ||
            !tags[cwTagKey].split('/')[0])
        ) {
          log
            .info()
            .str('function', 'checkAndManageTGStatusAlarms')
            .str('targetGroupName', targetGroupName)
            .str(cwTagKey, tags[cwTagKey])
            .msg(
              `TG alarm threshold for ${metricName} WARNING is not defined. Skipping static ${metricName} warning alarm creation.`
            );
          await deleteCWAlarm(staticThresholdAlarmName, targetGroupName);
        } else if (
          type === 'CRITICAL' &&
          (!tags[cwTagKey] ||
            tags[cwTagKey].split('/')[1] === '' ||
            tags[cwTagKey].split('/')[1] === undefined ||
            !tags[cwTagKey].split('/')[1])
        ) {
          log
            .info()
            .str('function', 'checkAndManageTGStatusAlarms')
            .str('targetGroupName', targetGroupName)
            .str(cwTagKey, tags[cwTagKey])
            .msg(
              `TG alarm threshold for ${metricName} CRITICAL is not defined. Skipping static ${metricName} critical alarm creation.`
            );
          await deleteCWAlarm(staticThresholdAlarmName, targetGroupName);
        } else {
          const alarmProps: AlarmProps = {
            threshold: threshold,
            period: 60,
            namespace: namespace,
            evaluationPeriods: 5,
            metricName: metricName,
            dimensions: [{Name: 'TargetGroup', Value: targetGroupName}],
          };

          // Create standard CloudWatch alarm
          await createOrUpdateCWAlarm(
            staticThresholdAlarmName,
            targetGroupName,
            alarmProps,
            threshold,
            durationStaticTime,
            durationStaticPeriods,
            'Maximum',
            type as AlarmClassification
          );
        }
      }
    }
  }
}

export async function manageTGAlarms(
  targetGroupName: string,
  tags: Tag
): Promise<void> {
  await checkAndManageTGStatusAlarms(targetGroupName, tags);
}

export async function manageInactiveTGAlarms(targetGroupName: string) {
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'TG',
      targetGroupName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName =>
        deleteCWAlarm(alarmName, targetGroupName)
      )
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

function extractTGNameFromArn(arn: string): string {
  const regex = /targetgroup\/([^/]+)\/[^/]+$/;
  const match = arn.match(regex);
  return match ? match[1] : '';
}

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

  const targetGroupName = extractTGNameFromArn(targetGroupArn);
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
    await manageTGAlarms(targetGroupName, tags);
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
