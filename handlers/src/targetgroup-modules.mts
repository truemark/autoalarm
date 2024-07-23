import {
  ElasticLoadBalancingV2Client,
  DescribeTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types.mjs';
import {AlarmClassification, ValidTargetGroupEvent} from './enums.mjs';
import {
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
} from './alarm-tools.mjs';

const log: logging.Logger = logging.getLogger('targetgroup-modules');
const elbClient: ElasticLoadBalancingV2Client =
  new ElasticLoadBalancingV2Client({});

const defaultThreshold = (type: AlarmClassification) =>
  type === 'CRITICAL' ? 95 : 90;

// Default values for duration and periods
const defaultDurationTime = 60; // e.g., 300 seconds
const defaultDurationPeriods = 2; // e.g., 5 periods

const metricConfigs = [
  {metricName: 'TargetResponseTime', namespace: 'AWS/ApplicationELB'},
  {metricName: 'RequestCountPerTarget', namespace: 'AWS/ApplicationELB'},
  {metricName: 'HTTPCode_Target_4XX_Count', namespace: 'AWS/ApplicationELB'},
  {metricName: 'HTTPCode_Target_5XX_Count', namespace: 'AWS/ApplicationELB'},
];

async function getAlarmConfig(
  targetGroupName: string,
  type: AlarmClassification,
  metricName: string
): Promise<{
  alarmName: string;
  threshold: number;
  durationTime: number;
  durationPeriods: number;
}> {
  const tags = await fetchTargetGroupTags(targetGroupName);
  const thresholdKey = `autoalarm:${metricName}-percent-above-${type.toLowerCase()}`;
  const durationTimeKey = `autoalarm:${metricName}-percent-duration-time`;
  const durationPeriodsKey = `autoalarm:${metricName}-percent-duration-periods`;

  // Get threshold, duration time, and duration periods from tags or use default values
  const threshold =
    tags[thresholdKey] !== undefined
      ? parseInt(tags[thresholdKey], 10)
      : defaultThreshold(type);
  const durationTime =
    tags[durationTimeKey] !== undefined
      ? parseInt(tags[durationTimeKey], 10)
      : defaultDurationTime;
  const durationPeriods =
    tags[durationPeriodsKey] !== undefined
      ? parseInt(tags[durationPeriodsKey], 10)
      : defaultDurationPeriods;

  return {
    alarmName: `AutoAlarm-TargetGroup-${targetGroupName}-${type}-${metricName}`,
    threshold,
    durationTime,
    durationPeriods,
  };
}

export async function fetchTargetGroupTags(
  targetGroupArn: string
): Promise<Tag> {
  try {
    const command = new DescribeTagsCommand({ResourceArns: [targetGroupArn]});
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
      .str('targetGroupArn', targetGroupArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched Target Group tags');

    return tags;
  } catch (error) {
    log
      .error()
      .err(error)
      .str('targetGroupArn', targetGroupArn)
      .msg('Error fetching Target Group tags');
    return {};
  }
}

async function checkAndManageTargetGroupStatusAlarms(
  targetGroupName: string,
  tags: Tag
) {
  if (tags['autoalarm:disabled'] === 'true') {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'TargetGroup',
      targetGroupName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName =>
        deleteCWAlarm(alarmName, targetGroupName)
      )
    );
    log.info().msg('Status check alarm creation skipped due to tag settings.');
  } else {
    for (const config of metricConfigs) {
      const {metricName, namespace} = config;
      for (const classification of Object.values(AlarmClassification)) {
        const {alarmName, threshold, durationTime, durationPeriods} =
          await getAlarmConfig(
            targetGroupName,
            classification as AlarmClassification,
            metricName
          );

        const alarmProps: AlarmProps = {
          threshold: threshold,
          period: 60,
          namespace: namespace,
          evaluationPeriods: 5,
          metricName: metricName,
          dimensions: [{Name: 'TargetGroup', Value: targetGroupName}],
        };

        await createOrUpdateCWAlarm(
          alarmName,
          targetGroupName,
          alarmProps,
          threshold,
          durationTime,
          durationPeriods,
          classification
        );
      }
    }
  }
}

export async function manageTargetGroupAlarms(
  targetGroupName: string,
  tags: Tag
): Promise<void> {
  await checkAndManageTargetGroupStatusAlarms(targetGroupName, tags);
}

export async function manageInactiveTargetGroupAlarms(targetGroupName: string) {
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'TargetGroup',
      targetGroupName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName =>
        deleteCWAlarm(alarmName, targetGroupName)
      )
    );
  } catch (e) {
    log.error().err(e).msg(`Error deleting Target Group alarms: ${e}`);
    throw new Error(`Error deleting Target Group alarms: ${e}`);
  }
}

export async function getTargetGroupEvent(event: any): Promise<{
  targetGroupArn: string;
  eventName: ValidTargetGroupEvent;
  tags: Tag;
}> {
  const targetGroupArn =
    event.detail.responseElements?.targetGroups[0]?.targetGroupArn;
  const eventName = event.detail.eventName as ValidTargetGroupEvent;

  log
    .info()
    .str('targetGroupArn', targetGroupArn)
    .str('eventName', eventName)
    .msg('Processing Target Group event');
  const tags = await fetchTargetGroupTags(targetGroupArn);

  if (targetGroupArn && eventName === ValidTargetGroupEvent.Active) {
    await manageTargetGroupAlarms(targetGroupArn, tags);
  } else if (eventName === ValidTargetGroupEvent.Deleted) {
    await manageInactiveTargetGroupAlarms(targetGroupArn);
  }

  return {targetGroupArn, eventName, tags};
}
