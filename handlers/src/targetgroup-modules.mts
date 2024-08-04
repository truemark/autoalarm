import {
  ElasticLoadBalancingV2Client,
  DescribeTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import * as logging from '@nr1e/logging';
import {Tag} from './types.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  PutMetricAlarmCommand,
  Statistic,
} from '@aws-sdk/client-cloudwatch';
import {AlarmClassification} from './enums.mjs';
import {
  getCWAlarmsForInstance,
  deleteCWAlarm,
  createOrUpdateAnomalyDetectionAlarm,
  doesAlarmExist,
} from './alarm-tools.mjs';

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
    tagKey: 'tg-unhealthy-host-count',
    metricName: 'UnHealthyHostCount',
    namespace: 'AWS/ApplicationELB',
    isDefault: true,
    anomaly: false,
    defaultValue: '-/1/60/3/Sum',
  },
  {
    tagKey: 'tg-unhealthy-host-count-anomaly',
    metricName: 'UnHealthyHostCount',
    namespace: 'AWS/ApplicationELB',
    isDefault: false,
    anomaly: true,
    defaultValue: 'p90/60/2',
  },
  {
    tagKey: 'tg-response-time',
    metricName: 'TargetResponseTime',
    namespace: 'AWS/ApplicationELB',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/60/2/p90',
  },
  {
    tagKey: 'tg-response-time-anomaly',
    metricName: 'TargetResponseTime',
    namespace: 'AWS/ApplicationELB',
    isDefault: true,
    anomaly: true,
    defaultValue: 'p90/60/2',
  },
  {
    tagKey: 'tg-request-count',
    metricName: 'RequestCountPerTarget',
    namespace: 'AWS/ApplicationELB',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/60/2/Sum',
  },
  {
    tagKey: 'tg-request-count-anomaly',
    metricName: 'RequestCountPerTarget',
    namespace: 'AWS/ApplicationELB',
    isDefault: false,
    anomaly: true,
    defaultValue: 'p90/60/2',
  },
  {
    tagKey: 'tg-4xx-count',
    metricName: 'HTTPCode_Target_4XX_Count',
    namespace: 'AWS/ApplicationELB',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/60/2/Sum',
  },
  {
    tagKey: 'tg-4xx-count-anomaly',
    metricName: 'HTTPCode_Target_4XX_Count',
    namespace: 'AWS/ApplicationELB',
    isDefault: false,
    anomaly: false,
    defaultValue: 'p90/60/2',
  },
  {
    tagKey: 'tg-5xx-count',
    metricName: 'HTTPCode_Target_5XX_Count',
    namespace: 'AWS/ApplicationELB',
    isDefault: false,
    anomaly: false,
    defaultValue: '-/-/60/2/Sum',
  },
  {
    tagKey: 'tg-5xx-count-anomaly',
    metricName: 'HTTPCode_Target_5XX_Count',
    namespace: 'AWS/ApplicationELB',
    isDefault: true,
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
  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';

  if (!isAlarmEnabled) {
    const activeAutoAlarms = await getCWAlarmsForInstance(
      'TG',
      targetGroupName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName =>
        deleteCWAlarm(alarmName, targetGroupName)
      )
    );
    log.info().msg('Status check alarm creation skipped due to tag settings.');
    return;
  }

  // Check and manage alarms for each metric configuration
  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageTGStatusAlarms')
      .obj('config', config)
      .str('TargetGroupName', targetGroupName)
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
      const alarmName = `AutoAlarm-TG-${targetGroupName}-${config.metricName}-Anomaly-Critical`;

      if (defaults.stat) {
        // Create critical alarm
        if (defaults.stat !== '-' && defaults.stat !== 'disabled') {
          await createOrUpdateAnomalyDetectionAlarm(
            alarmName,
            'TargetGroup',
            targetGroupName,
            config.metricName,
            config.namespace,
            defaults.stat,
            defaults.duration,
            defaults.periods,
            AlarmClassification.Critical
          );
        }
      } else if (await doesAlarmExist(alarmName)) {
        await cloudWatchClient.send(
          new DeleteAlarmsCommand({
            AlarmNames: [alarmName],
          })
        );
      }
    } else {
      const alarmNamePrefix = `AutoAlarm-TG-${targetGroupName}-${config.metricName}`;
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
            Dimensions: [{Name: 'TargetGroup', Value: targetGroupName}],
            Tags: [{Key: 'severity', Value: 'Warning'}],
            TreatMissingData: 'ignore',
          })
        );
      } else if (await doesAlarmExist(`${alarmNamePrefix}-Warning`)) {
        await cloudWatchClient.send(
          new DeleteAlarmsCommand({
            AlarmNames: [`${alarmNamePrefix}-Warning`],
          })
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
            Dimensions: [{Name: 'TargetGroup', Value: targetGroupName}],
            Tags: [{Key: 'severity', Value: 'Critical'}],
            TreatMissingData: 'ignore',
          })
        );
      } else if (await doesAlarmExist(`${alarmNamePrefix}-Critical`)) {
        await cloudWatchClient.send(
          new DeleteAlarmsCommand({
            AlarmNames: [`${alarmNamePrefix}-Critical`],
          })
        );
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
