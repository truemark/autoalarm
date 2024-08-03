import {
  ElasticLoadBalancingV2Client,
  DescribeTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import * as logging from '@nr1e/logging';
import {Tag, AlarmProps} from './types.mjs';
import {AlarmClassification} from './enums.mjs';
import {Statistic} from '@aws-sdk/client-cloudwatch';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {
  getCWAlarmsForInstance,
  deleteCWAlarm,
  createOrUpdateAnomalyDetectionAlarm,
  createOrUpdateCWAlarm,
} from './alarm-tools.mjs';

const log: logging.Logger = logging.getLogger('alb-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const elbClient: ElasticLoadBalancingV2Client =
  new ElasticLoadBalancingV2Client({
    region,
    retryStrategy,
  });

const metricConfigs = [
  {metricName: 'RequestCount', namespace: 'AWS/ApplicationELB'},
  {metricName: 'HTTPCode_ELB_4XX_Count', namespace: 'AWS/ApplicationELB'},
  {metricName: 'HTTPCode_ELB_5XX_Count', namespace: 'AWS/ApplicationELB'},
];

// Default values for duration and periods
const defaultThreshold: string | number = '-';
const defaultStaticDurationTime = 60; // e.g., 300 seconds
const defaultStaticDurationPeriods = 2; // e.g., 5 periods
const defaultStaticStatistic: Statistic | string = 'Sum';
const defaultAnomalyDurationTime = 60; // e.g., 300 seconds
const defaultAnomalyDurationPeriods = 2; // e.g., 5 periods
const defaultExtendedAnomalyStatistic: string = 'p90';
// used as input validation for extended statistics
const extendedStatRegex = /^p.*|^tm.*|^tc.*|^ts.*|^wm.*|^IQM$/;

async function getALBAlarmConfig(
  loadBalancerName: string,
  type: AlarmClassification,
  metricName: string,
  tags: Tag
): Promise<{
  staticThresholdAlarmName: string;
  anomalyAlarmName: string;
  extendedAnomalyStatistic: string;
  threshold: string | number;
  durationStaticTime: number;
  durationStaticPeriods: number;
  staticStatistic: Statistic | string;
  durationAnomalyTime: number;
  durationAnomalyPeriods: number;
}> {
  log
    .info()
    .str('function', 'getALBAlarmConfig')
    .str('instanceId', loadBalancerName)
    .str('type', type)
    .str('metric', metricName)
    .msg('Fetching alarm configuration');

  // Initialize variables with default values
  let threshold: string | number = defaultThreshold as string;
  let extendedAnomalyStatistic = defaultExtendedAnomalyStatistic;
  const staticStatistic = defaultStaticStatistic;
  let durationStaticTime = defaultStaticDurationTime;
  let durationStaticPeriods = defaultStaticDurationPeriods;
  let durationAnomalyTime = defaultAnomalyDurationTime;
  let durationAnomalyPeriods = defaultAnomalyDurationPeriods;

  log
    .info()
    .str('function', 'getALBAlarmConfig')
    .str('Loadbalancer Name', loadBalancerName)
    .msg('Fetching alarm configuration');

  // Define tag keys based on metric
  let cwTagKey = '';
  let anomalyTagKey = '';

  switch (metricName) {
    case 'RequestCount':
      cwTagKey = 'autoalarm:alb-request-count';
      anomalyTagKey = 'autoalarm:alb-request-count-anomaly';
      break;
    case 'HTTPCode_ELB_4XX_Count':
      cwTagKey = 'autoalarm:alb-4xx-count';
      anomalyTagKey = 'autoalarm:alb-4xx-count-anomaly';
      break;
    case 'HTTPCode_ELB_5XX_Count':
      cwTagKey = 'autoalarm:alb-5xx-count';
      anomalyTagKey = 'autoalarm:alb-5xx-count-anomaly';
      break;
  }

  log
    .info()
    .str('function', 'getALBAlarmConfig')
    .str('Loadbalancer Name', loadBalancerName)
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
      .info()
      .str('function', 'getALBAlarmConfig')
      .str('Loadbalancer Name', loadBalancerName)
      .str('cwTagKey', cwTagKey)
      .str('cwTagValue', tags[cwTagKey])
      .str('staticValues', JSON.stringify(staticValues))
      .msg('Fetched Static Threshold tag values');

    if (staticValues.length >= 1 && staticValues.length <= 4) {
      const thresholdIndex = type === 'WARNING' ? 0 : 1;
      if (
        staticValues[thresholdIndex] !== undefined &&
        staticValues[thresholdIndex] !== '' &&
        !isNaN(Number(staticValues[thresholdIndex]))
      ) {
        threshold = Number(staticValues[thresholdIndex]);
      }

      if (
        staticValues[2] !== undefined &&
        staticValues[2] !== '' &&
        !isNaN(parseInt(staticValues[2], 10))
      ) {
        durationStaticTime = parseInt(staticValues[2], 10);
      }

      if (
        staticValues[3] !== undefined &&
        staticValues[3] !== '' &&
        !isNaN(parseInt(staticValues[3], 10))
      ) {
        durationStaticPeriods = parseInt(staticValues[3], 10);
      }
    } else {
      log
        .warn()
        .str('function', 'getALBAlarmConfig')
        .str('Loadbalancer Name', loadBalancerName)
        .str('cwTagKey', cwTagKey)
        .str('cwTagValue', tags[cwTagKey])
        .msg(
          'Invalid tag values/delimiters. Please use 4 values separated by a "/". Using default values'
        );
    }
  }

  // Extract and parse the anomaly detection tag values
  if (tags[anomalyTagKey]) {
    const values = tags[anomalyTagKey].split('/');
    if (!extendedStatRegex.test(values[0].trim())) {
      log
        .warn()
        .str('function', 'getALBAlarmConfig')
        .str('Loadbalancer Name', loadBalancerName)
        .str('tagKey', anomalyTagKey)
        .str('tagValue', tags[anomalyTagKey])
        .msg(
          "Invalid extended statistic value. Please use a valid percentile value. Using default value of 'p90'"
        );
      values[0] = defaultExtendedAnomalyStatistic;
    }
    log
      .info()
      .str('function', 'getALBAlarmConfig')
      .str('Loadbalancer Name', loadBalancerName)
      .str('anomalyTagKey', anomalyTagKey)
      .str('anomalyTagValue', tags[anomalyTagKey])
      .str('values', JSON.stringify(values))
      .msg('Fetched Anomaly Detection tag values');

    if (values.length >= 1 && values.length <= 3) {
      extendedAnomalyStatistic =
        typeof values[0] === 'string' && values[0].trim() !== ''
          ? values[0].trim()
          : defaultExtendedAnomalyStatistic;

      if (
        values[1] !== undefined &&
        values[1] !== '' &&
        !isNaN(parseInt(values[1], 10))
      ) {
        durationAnomalyTime = parseInt(values[1], 10);
      }

      if (
        values[2] !== undefined &&
        values[2] !== '' &&
        !isNaN(parseInt(values[2], 10))
      ) {
        durationAnomalyPeriods = parseInt(values[2], 10);
      }
    } else {
      log
        .warn()
        .str('function', 'getALBAlarmConfig')
        .str('Loadbalancer Name', loadBalancerName)
        .str('anomalyTagKey', anomalyTagKey)
        .str('anomalyTagValue', tags[anomalyTagKey])
        .msg(
          'Invalid tag values/delimiters. Please use 3 values separated by a "/". Using default values'
        );
    }
  }

  log
    .info()
    .str('function', 'getALBAlarmConfig')
    .str('Loadbalancer Name', loadBalancerName)
    .str('type', type)
    .str('metricName', metricName)
    .str(
      'staticThresholdAlarmName',
      `AutoAlarm-ALB-StaticThreshold-${loadBalancerName}-${type}-${metricName.toUpperCase()}`
    )
    .str(
      'anomalyAlarmName',
      `AutoAlarm-ALB-AnomalyDetection-${loadBalancerName}-CRITICAL-${metricName.toUpperCase()}`
    )
    .str('Static Threshold Alarm Statistic', staticStatistic)
    .str('Extended Anomaly Statistic', extendedAnomalyStatistic)
    .num('threshold', threshold as number)
    .num('durationStaticTime', durationStaticTime)
    .num('durationStaticPeriods', durationStaticPeriods)
    .num('durationAnomalyTime', durationAnomalyTime)
    .num('durationAnomalyPeriods', durationAnomalyPeriods)
    .msg('Fetched alarm configuration');

  return {
    staticThresholdAlarmName: `AutoAlarm-ALB-StaticThreshold-${loadBalancerName}-${type}-${metricName.toUpperCase()}`,
    anomalyAlarmName: `AutoAlarm-ALB-AnomalyDetection-${loadBalancerName}-CRITICAL-${metricName.toUpperCase()}`,
    extendedAnomalyStatistic,
    threshold,
    durationStaticTime,
    durationStaticPeriods,
    staticStatistic,
    durationAnomalyTime,
    durationAnomalyPeriods,
  };
}

export async function fetchALBTags(loadBalancerArn: string): Promise<Tag> {
  try {
    const command = new DescribeTagsCommand({
      ResourceArns: [loadBalancerArn],
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

async function checkAndManageALBStatusAlarms(
  loadBalancerName: string,
  tags: Tag
) {
  if (tags['autoalarm:enabled'] === 'false' || !tags['autoalarm:enabled']) {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'ALB',
      loadBalancerName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName =>
        deleteCWAlarm(alarmName, loadBalancerName)
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
        case 'RequestCount':
          cwTagKey = 'autoalarm:alb-request-count';
          anomalyTagKey = 'autoalarm:alb-request-count-anomaly';
          break;
        case 'HTTPCode_ELB_4XX_Count':
          cwTagKey = 'autoalarm:alb-4xx-count';
          anomalyTagKey = 'autoalarm:alb-4xx-count-anomaly';
          break;
        case 'HTTPCode_ELB_5XX_Count':
          cwTagKey = 'autoalarm:alb-5xx-count';
          anomalyTagKey = 'autoalarm:alb-5xx-count-anomaly';
          break;
        default:
          log
            .warn()
            .str('function', 'getALBAlarmConfig')
            .str('metricName', metricName)
            .msg('Unexpected metric name');
      }

      log
        .info()
        .str('function', 'checkAndManageALBStatusAlarms')
        .str('loadBalancerName', loadBalancerName)
        .str('cwTagKey', cwTagKey)
        .str('cwTagValue', tags[cwTagKey] || 'undefined')
        .str('anomalyTagKey', anomalyTagKey)
        .str('anomalyTagValue', tags[anomalyTagKey] || 'undefined')
        .msg('Tag values before processing');

      for (const type of ['WARNING', 'CRITICAL'] as AlarmClassification[]) {
        const {
          staticThresholdAlarmName,
          anomalyAlarmName,
          extendedAnomalyStatistic,
          threshold,
          durationStaticTime,
          durationStaticPeriods,
          staticStatistic,
          durationAnomalyTime,
          durationAnomalyPeriods,
        } = await getALBAlarmConfig(loadBalancerName, type, metricName, tags);

        // Create or update anomaly detection alarms
        switch (anomalyAlarmName) {
          case `AutoAlarm-ALB-AnomalyDetection-${loadBalancerName}-CRITICAL-REQUESTCOUNT`:
            if (!tags['autoalarm:alb-request-count-anomaly']) {
              log
                .info()
                .str('function', 'checkAndManageALBStatusAlarms')
                .str('loadBalancerName', loadBalancerName)
                .str('anomalyAlarmName', anomalyAlarmName)
                .msg('Skipping anomaly detection alarm creation');
              break;
            } else if (
              tags[anomalyTagKey].split('/')[0] !== 'disabled' ||
              tags[anomalyTagKey].split('/')[0] !== '-' ||
              tags[anomalyTagKey] !== 'disabled'
            ) {
              await createOrUpdateAnomalyDetectionAlarm(
                anomalyAlarmName,
                'LoadBalancer',
                loadBalancerName,
                metricName,
                namespace,
                extendedAnomalyStatistic,
                durationAnomalyTime,
                durationAnomalyPeriods,
                'CRITICAL' as AlarmClassification
              );
              log
                .info()
                .str('function', 'checkAndManageALBStatusAlarms')
                .str('loadBalancerName', loadBalancerName)
                .str('anomalyAlarmName', anomalyAlarmName)
                .msg('Creating or updating anomaly detection alarm');
            }
            break;
          case `AutoAlarm-ALB-AnomalyDetection-${loadBalancerName}-CRITICAL-HTTPCODE_ELB_4XX_COUNT`:
            if (!tags['autoalarm:alb-4xx-count-anomaly']) {
              log
                .info()
                .str('function', 'checkAndManageALBStatusAlarms')
                .str('loadBalancerName', loadBalancerName)
                .str('anomalyAlarmName', anomalyAlarmName)
                .msg('Skipping anomaly detection alarm creation');
              break;
            } else if (
              tags[anomalyTagKey].split('/')[0] !== 'disabled' ||
              tags[anomalyTagKey].split('/')[0] !== '-' ||
              tags[anomalyTagKey] !== 'disabled'
            ) {
              await createOrUpdateAnomalyDetectionAlarm(
                anomalyAlarmName,
                'LoadBalancer',
                loadBalancerName,
                metricName,
                namespace,
                extendedAnomalyStatistic,
                durationAnomalyTime,
                durationAnomalyPeriods,
                'CRITICAL' as AlarmClassification
              );
              log
                .info()
                .str('function', 'checkAndManageALBStatusAlarms')
                .str('loadBalancerName', loadBalancerName)
                .str('anomalyAlarmName', anomalyAlarmName)
                .msg('Created anomaly detection alarm');
            }
            break;
          case `AutoAlarm-ALB-AnomalyDetection-${loadBalancerName}-CRITICAL-HTTPCODE_ELB_5XX_COUNT`:
            if (
              !tags[anomalyTagKey] ||
              (tags[anomalyTagKey] &&
                (tags[anomalyTagKey].split('/')[0] !== 'disabled' ||
                  tags[anomalyTagKey].split('/')[0] !== '-' ||
                  tags[anomalyTagKey] !== 'disabled'))
            ) {
              await createOrUpdateAnomalyDetectionAlarm(
                anomalyAlarmName,
                'LoadBalancer',
                loadBalancerName,
                metricName,
                namespace,
                extendedAnomalyStatistic,
                durationAnomalyTime,
                durationAnomalyPeriods,
                'CRITICAL' as AlarmClassification
              );
              log
                .info()
                .str('function', 'checkAndManageALBStatusAlarms')
                .str('loadBalancerName', loadBalancerName)
                .str('anomalyAlarmName', anomalyAlarmName)
                .msg(
                  `Creating ${anomalyAlarmName} by default using tag values or default values if tag does not exist.`
                );
              break;
            }

            // Check and create or delete static threshold alarm based on tag values
            if (
              type === 'WARNING' &&
              (!tags[cwTagKey] ||
                tags[cwTagKey].split('/')[0] === 'disabled' ||
                tags[cwTagKey].split('/')[0] === '-' ||
                !tags[cwTagKey].split('/')[0] ||
                tags[cwTagKey] === 'disabled')
            ) {
              log
                .info()
                .str('function', 'checkAndManageALBStatusAlarms')
                .str('loadBalancerName', loadBalancerName)
                .str(cwTagKey, tags[cwTagKey])
                .msg(
                  `ALB alarm threshold for ${metricName} WARNING is not defined. Skipping static ${metricName} warning alarm creation.`
                );
              await deleteCWAlarm(staticThresholdAlarmName, loadBalancerName);
            } else if (
              type === 'CRITICAL' &&
              (!tags[cwTagKey] ||
                tags[cwTagKey].split('/')[1] === 'disabled' ||
                tags[cwTagKey].split('/')[1] === '-' ||
                !tags[cwTagKey].split('/')[1] ||
                tags[cwTagKey] === 'disabled')
            ) {
              log
                .info()
                .str('function', 'checkAndManageALBStatusAlarms')
                .str('loadBalancerName', loadBalancerName)
                .str(cwTagKey, tags[cwTagKey])
                .msg(
                  `ALB alarm threshold for ${metricName} CRITICAL is not defined. Skipping static ${metricName} critical alarm creation.`
                );
              await deleteCWAlarm(staticThresholdAlarmName, loadBalancerName);
            } else {
              const alarmProps: AlarmProps = {
                threshold: threshold as number,
                period: durationStaticTime,
                namespace: namespace,
                evaluationPeriods: durationStaticPeriods,
                metricName: metricName,
                dimensions: [{Name: 'LoadBalancer', Value: loadBalancerName}],
              };

              if (extendedStatRegex.test(staticStatistic)) {
                await createOrUpdateCWAlarm(
                  staticThresholdAlarmName,
                  loadBalancerName,
                  alarmProps,
                  threshold as number,
                  durationStaticTime,
                  durationStaticPeriods,
                  type as AlarmClassification,
                  'ignore',
                  undefined,
                  staticStatistic
                );
              } else {
                await createOrUpdateCWAlarm(
                  staticThresholdAlarmName,
                  loadBalancerName,
                  alarmProps,
                  threshold as number,
                  durationStaticTime,
                  durationStaticPeriods,
                  type as AlarmClassification,
                  'ignore',
                  staticStatistic as Statistic,
                  undefined
                );
              }
            }
        }
      }
    }
  }
}

export async function manageALBAlarms(
  loadBalancerName: string,
  tags: Tag
): Promise<void> {
  await checkAndManageALBStatusAlarms(loadBalancerName, tags);
}

export async function manageInactiveALBAlarms(loadBalancerName: string) {
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'ALB',
      loadBalancerName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName =>
        deleteCWAlarm(alarmName, loadBalancerName)
      )
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
