import {
  ElasticLoadBalancingV2Client,
  DescribeTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import * as logging from '@nr1e/logging';
import {Tag} from './types.mjs';
import {AlarmClassification} from './enums.mjs';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  PutMetricAlarmCommand,
  Statistic,
} from '@aws-sdk/client-cloudwatch';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {
  getCWAlarmsForInstance,
  deleteCWAlarm,
  createOrUpdateAnomalyDetectionAlarm,
  doesAlarmExist,
} from './alarm-tools.mjs';
import {ALBEvent} from "./event-types.mjs";

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
    tagKey: 'alb-4xx-count',
    metricName: 'HTTPCode_ELB_4XX_Count',
    namespace: 'AWS/ApplicationELB',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/60/2/Sum',
  },
  {
    tagKey: 'alb-4xx-anomaly',
    metricName: 'HTTPCode_ELB_4XX_Count',
    namespace: 'AWS/ApplicationELB',
    isDefault: false,
    anomaly: true,
    defaultValue: 'p90/60/2',
  },
  {
    tagKey: 'alb-5xx-count',
    metricName: 'HTTPCode_ELB_5XX_Count',
    namespace: 'AWS/ApplicationELB',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/60/2/Sum',
  },
  {
    tagKey: 'alb-5xx-count-anomaly',
    metricName: 'HTTPCode_ELB_5XX_Count',
    namespace: 'AWS/ApplicationELB',
    isDefault: true,
    anomaly: true,
    defaultValue: 'p90/60/2',
  },
  {
    tagKey: 'alb-request-count',
    metricName: 'RequestCount',
    namespace: 'AWS/ApplicationELB',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/60/2/Sum',
  },
  {
    tagKey: 'alb-request-count-anomaly',
    metricName: 'RequestCount',
    namespace: 'AWS/ApplicationELB',
    isDefault: false,
    anomaly: true,
    defaultValue: 'p90/60/2',
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

async function checkAndManageALBStatusAlarms(
  loadBalancerName: string,
  tags: Tag,
) {
  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    const activeAutoAlarms = await getCWAlarmsForInstance(
      'ALB',
      loadBalancerName,
    );
    await Promise.all(
      activeAutoAlarms.map((alarmName) =>
        deleteCWAlarm(alarmName, loadBalancerName),
      ),
    );
    log.info().msg('Status check alarm creation skipped due to tag settings.');
    return;
  }

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageALBStatusAlarms')
      .obj('config', config)
      .str('LoadBalancerName', loadBalancerName)
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
      const alarmName = `AutoAlarm-ALB-${loadBalancerName}-${config.metricName}-Anomaly-Critical`;
      if (defaults.stat) {
        // Create critical alarm
        if (defaults.stat !== '-' && defaults.stat !== 'disabled') {
          await createOrUpdateAnomalyDetectionAlarm(
            alarmName,
            'LoadBalancer',
            loadBalancerName,
            config.metricName,
            config.namespace,
            defaults.stat,
            defaults.duration,
            defaults.periods,
            AlarmClassification.Critical,
          );
        }
      } else if (await doesAlarmExist(alarmName)) {
        await cloudWatchClient.send(
          new DeleteAlarmsCommand({
            AlarmNames: [alarmName],
          }),
        );
      }
    } else {
      const alarmNamePrefix = `AutoAlarm-ALB-${loadBalancerName}-${config.metricName}`;
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
            Dimensions: [{Name: 'LoadBalancer', Value: loadBalancerName}],
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
            Dimensions: [{Name: 'LoadBalancer', Value: loadBalancerName}],
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
export async function parseALBEventAndCreateAlarms(event: ALBEvent): Promise<{
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
