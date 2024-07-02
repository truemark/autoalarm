import {
  ElasticLoadBalancingV2Client,
  DescribeTagsCommand,
  DescribeLoadBalancersCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types';
import {AlarmClassification, ValidAlbState} from './enums';
import {
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
} from './alarm-tools';

const log: logging.Logger = logging.getRootLogger();
const elbClient: ElasticLoadBalancingV2Client =
  new ElasticLoadBalancingV2Client({});
const defaultThresholds: {[key in AlarmClassification]: number} = {
  [AlarmClassification.Critical]: 15000,
  [AlarmClassification.Warning]: 10000,
};
const metricConfigs = [
  {metricName: 'RequestCount', namespace: 'AWS/ApplicationELB'},
  {metricName: 'HTTPCode_ELB_4XX_Count', namespace: 'AWS/ApplicationELB'},
  {metricName: 'HTTPCode_ELB_5XX_Count', namespace: 'AWS/ApplicationELB'},
];

async function getAlarmConfig(
  loadBalancerName: string,
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
    alarmName: `AutoAlarm-ALB-${loadBalancerName}-${type}-${metricName}`,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey,
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
      .str('loadBalancerArn', loadBalancerArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched ALB tags');

    return tags;
  } catch (error) {
    log
      .error()
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
      'alb',
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
        const {alarmName, thresholdKey, durationTimeKey, durationPeriodsKey} =
          await getAlarmConfig(
            loadBalancerName,
            classification as AlarmClassification,
            metricName
          );

        const alarmProps: AlarmProps = {
          threshold: defaultThresholds[classification as AlarmClassification],
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
          tags,
          thresholdKey,
          durationTimeKey,
          durationPeriodsKey
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
      'alb',
      loadBalancerName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName =>
        deleteCWAlarm(alarmName, loadBalancerName)
      )
    );
  } catch (e) {
    log.error().err(e).msg(`Error deleting ALB alarms: ${e}`);
    throw new Error(`Error deleting ALB alarms: ${e}`);
  }
}

export async function getAlbState(
  event: any
): Promise<{loadBalancerArn: string; state: ValidAlbState; tags: Tag}> {
  const loadBalancerArn = event.resources[0];
  log
    .info()
    .str('loadBalancerArn', loadBalancerArn)
    .msg('Processing tag event');

  const describeLoadBalancersResponse = await elbClient.send(
    new DescribeLoadBalancersCommand({
      LoadBalancerArns: [loadBalancerArn],
    })
  );

  const loadBalancer = describeLoadBalancersResponse.LoadBalancers?.[0];
  const state =
    (loadBalancer?.State?.Code as ValidAlbState) || ValidAlbState.Active;
  const tags = await fetchALBTags(loadBalancerArn);

  return {loadBalancerArn, state, tags};
}
