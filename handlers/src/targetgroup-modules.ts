import {
  ElasticLoadBalancingV2Client,
  DescribeTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types';
import {AlarmClassification, ValidTargetGroupEvent} from './enums';
import {
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
} from './alarm-tools';

const log: logging.Logger = logging.getRootLogger();
const elbClient: ElasticLoadBalancingV2Client =
  new ElasticLoadBalancingV2Client({});

const defaultThresholds: {[key in AlarmClassification]: number} = {
  [AlarmClassification.Critical]: 90,
  [AlarmClassification.Warning]: 80,
};

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
  thresholdKey: string;
  durationTimeKey: string;
  durationPeriodsKey: string;
}> {
  const thresholdKey = `autoalarm:${metricName}-percent-above-${type.toLowerCase()}`;
  const durationTimeKey = `autoalarm:${metricName}-percent-duration-time`;
  const durationPeriodsKey = `autoalarm:${metricName}-percent-duration-periods`;

  return {
    alarmName: `AutoAlarm-TargetGroup-${targetGroupName}-${type}-${metricName}`,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey,
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
  loadBalancerName: string,
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
        const {alarmName, thresholdKey, durationTimeKey, durationPeriodsKey} =
          await getAlarmConfig(
            targetGroupName,
            classification as AlarmClassification,
            metricName
          );

        const alarmProps: AlarmProps = {
          threshold: defaultThresholds[classification as AlarmClassification],
          period: 60,
          namespace: namespace,
          evaluationPeriods: 5,
          metricName: metricName,
          dimensions: [
            {Name: 'TargetGroup', Value: targetGroupName},
            {Name: 'LoadBalancer', Value: loadBalancerName},
          ],
        };

        await createOrUpdateCWAlarm(
          alarmName,
          targetGroupName,
          alarmProps,
          tags,
          thresholdKey,
          durationTimeKey,
          durationPeriodsKey
        );
      }
    }
  }
}

export async function manageTargetGroupAlarms(
  targetGroupName: string,
  loadBalancerName: string,
  tags: Tag
): Promise<void> {
  await checkAndManageTargetGroupStatusAlarms(
    targetGroupName,
    loadBalancerName,
    tags
  );
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
  loadBalancerName: string;
  eventName: ValidTargetGroupEvent;
  tags: Tag;
}> {
  const targetGroupArn =
    event.detail.responseElements?.targetGroups[0]?.targetGroupArn;
  const loadBalancerName =
    event.detail.responseElements?.loadBalancers[0]?.loadBalancerName;
  const eventName = event.detail.eventName as ValidTargetGroupEvent;

  log
    .info()
    .str('targetGroupArn', targetGroupArn)
    .str('loadBalancerName', loadBalancerName)
    .str('eventName', eventName)
    .msg('Processing Target Group event');
  const tags = await fetchTargetGroupTags(targetGroupArn);

  if (targetGroupArn && eventName === ValidTargetGroupEvent.Active) {
    await manageTargetGroupAlarms(targetGroupArn, loadBalancerName, tags);
  } else if (eventName === ValidTargetGroupEvent.Deleted) {
    await manageInactiveTargetGroupAlarms(targetGroupArn);
  }

  return {targetGroupArn, loadBalancerName, eventName, tags};
}
