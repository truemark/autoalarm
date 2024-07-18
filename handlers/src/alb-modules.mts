import {
  ElasticLoadBalancingV2Client,
  DescribeTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types.mjs';
import {AlarmClassification, ValidAlbEvent} from './enums.mjs';
import {
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
} from './alarm-tools.mjs';

const log: logging.Logger = logging.getLogger('alb-modules');
const elbClient: ElasticLoadBalancingV2Client =
  new ElasticLoadBalancingV2Client({});

const metricConfigs = [
  {metricName: 'RequestCount', namespace: 'AWS/ApplicationELB'},
  {metricName: 'HTTPCode_ELB_4XX_Count', namespace: 'AWS/ApplicationELB'},
  {metricName: 'HTTPCode_ELB_5XX_Count', namespace: 'AWS/ApplicationELB'},
];

const defaultThreshold = (type: AlarmClassification) =>
  type === 'CRITICAL' ? 15000 : 10000;

// Default values for duration and periods
const defaultDurationTime = 60; // e.g., 300 seconds
const defaultDurationPeriods = 2; // e.g., 5 periods

async function getAlarmConfig(
  loadBalancerName: string,
  type: AlarmClassification,
  metricName: string
): Promise<{
  alarmName: string;
  threshold: number;
  durationTime: number;
  durationPeriods: number;
}> {
  const tags = await fetchALBTags(loadBalancerName);
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
    alarmName: `AutoAlarm-ALB-${loadBalancerName}-${type}-${metricName}`,
    threshold,
    durationTime,
    durationPeriods,
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
  if (tags['autoalarm:disabled'] === 'true') {
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
  } else {
    for (const config of metricConfigs) {
      const {metricName, namespace} = config;
      for (const classification of Object.values(AlarmClassification)) {
        const {alarmName, threshold, durationTime, durationPeriods} =
          await getAlarmConfig(
            loadBalancerName,
            classification as AlarmClassification,
            metricName
          );

        const alarmProps: AlarmProps = {
          threshold: threshold,
          period: 60,
          namespace: namespace,
          evaluationPeriods: 5,
          metricName: metricName,
          dimensions: [{Name: 'LoadBalancer', Value: loadBalancerName}],
        };

        await createOrUpdateCWAlarm(
          alarmName,
          loadBalancerName,
          alarmProps,
          threshold,
          durationTime,
          durationPeriods
        );
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

export async function getAlbEvent(
  event: any
): Promise<{loadBalancerArn: string; eventName: ValidAlbEvent; tags: Tag}> {
  const loadBalancerArn =
    event.detail.responseElements?.loadBalancers[0]?.loadBalancerArn;
  const eventName = event.detail.eventName as ValidAlbEvent;
  log
    .info()
    .str('function', 'getAlbEvent')
    .str('loadBalancerArn', loadBalancerArn)
    .str('eventName', eventName)
    .msg('Processing ALB event');
  const tags = await fetchALBTags(loadBalancerArn);

  if (loadBalancerArn && eventName === ValidAlbEvent.Active) {
    await manageALBAlarms(loadBalancerArn, tags);
  } else if (eventName === ValidAlbEvent.Deleted) {
    await manageInactiveALBAlarms(loadBalancerArn);
  }

  return {loadBalancerArn, eventName, tags};
}
