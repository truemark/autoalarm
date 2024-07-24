import {
  ElasticLoadBalancingV2Client,
  DescribeTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types.mjs';
import {AlarmClassification} from './enums.mjs';
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
  type === 'CRITICAL' ? 1500 : 1000;

// Default values for duration and periods
const defaultDurationTime = 60; // e.g., 300 seconds
const defaultDurationPeriods = 2; // e.g., 5 periods

async function getALBAlarmConfig(
  loadBalancerName: string,
  type: AlarmClassification,
  service: string,
  metricName: string,
  tags: Tag
): Promise<{
  alarmName: string;
  threshold: number;
  durationTime: number;
  durationPeriods: number;
}> {
  log
    .info()
    .str('function', 'getALBAlarmConfig')
    .str('instanceId', loadBalancerName)
    .str('type', type)
    .str('metric', metricName)
    .msg('Fetching alarm configuration');

  // Initialize variables with default values
  let threshold = defaultThreshold(type);
  let durationTime = defaultDurationTime;
  let durationPeriods = defaultDurationPeriods;
  log
    .info()
    .str('function', 'getALBAlarmConfig')
    .str(
      'alarmName',
      `AutoAlarm-${service}-${service}-${type}-${metricName.toUpperCase()}`
    )
    .str('Loadbalancer Name', loadBalancerName)
    .msg('Fetching alarm configuration');

  // Define tag key based on metric
  const tagKey = `autoalarm:${service}-${metricName}`;

  log
    .info()
    .str('function', 'getALBAlarmConfig')
    .str('Loadbalancer Name', loadBalancerName)
    .str('tags', JSON.stringify(tags))
    .str('tagKey', tagKey)
    .str('tagValue', tags[tagKey])
    .msg('Fetched instance tags');

  // Extract and parse the tag value
  if (tags[tagKey]) {
    const values = tags[tagKey].split('|');
    if (values.length < 1 || values.length > 4) {
      log
        .warn()
        .str('function', 'getALBAlarmConfig')
        .str('Loadbalancer Name', loadBalancerName)
        .str('tagKey', tagKey)
        .str('tagValue', tags[tagKey])
        .msg(
          'Invalid tag values/delimiters. Please use 4 values seperated by a "|". Using default values'
        );
    } else {
      switch (type) {
        case 'WARNING':
          threshold = !isNaN(parseInt(values[0]))
            ? parseInt(values[0], 10)
            : defaultThreshold(type);
          durationTime = !isNaN(parseInt(values[2]))
            ? parseInt(values[2], 10)
            : defaultDurationTime;
          durationPeriods = !isNaN(parseInt(values[3]))
            ? parseInt(values[3], 10)
            : defaultDurationPeriods;
          break;
        case 'CRITICAL':
          threshold = !isNaN(parseInt(values[1]))
            ? parseInt(values[1], 10)
            : defaultThreshold(type);
          durationTime = !isNaN(parseInt(values[2]))
            ? parseInt(values[2], 10)
            : defaultDurationTime;
          durationPeriods = !isNaN(parseInt(values[3]))
            ? parseInt(values[3], 10)
            : defaultDurationPeriods;
          break;
      }
    }
  }
  return {
    alarmName: `AutoAlarm-${service.toUpperCase()}-${loadBalancerName}-${type}-${metricName.toUpperCase()}`,
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
      for (const classification of Object.values(AlarmClassification)) {
        const {alarmName, threshold, durationTime, durationPeriods} =
          await getALBAlarmConfig(
            loadBalancerName,
            classification as AlarmClassification,
            'alb',
            metricName,
            tags
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
          durationPeriods,
          classification
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
