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

const log: logging.Logger = logging.getLogger('targetgroup-modules');
const elbClient: ElasticLoadBalancingV2Client =
  new ElasticLoadBalancingV2Client({});

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
const defaultDurationTime = 60; // e.g., 300 seconds
const defaultDurationPeriods = 2; // e.g., 5 periods

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
  threshold: number;
  durationTime: number;
  durationPeriods: number;
}> {
  log
    .info()
    .str('function', 'getTGAlarmConfig')
    .str('instanceId', targetGroupName)
    .str('type', type)
    .str('metric', metricName)
    .msg('Fetching alarm configuration');

  // Initialize variables with default values
  let threshold = getDefaultThreshold(metricName, type);
  let durationTime = defaultDurationTime;
  let durationPeriods = defaultDurationPeriods;
  log
    .info()
    .str('function', 'getTGAlarmConfig')
    .str(
      'alarmName',
      `AutoAlarm-${service}-${service}-${type}-${metricName.toUpperCase()}`
    )
    .str('TargetGroupName', targetGroupName)
    .msg('Fetching alarm configuration');

  // Define tag key based on metric
  const tagKey = `autoalarm:${service}-${metricName}`;

  log
    .info()
    .str('function', 'getTGAlarmConfig')
    .str('TargetGroupName', targetGroupName)
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
        .str('function', 'getTGAlarmConfig')
        .str('TargetGroupName', targetGroupName)
        .str('tagKey', tagKey)
        .str('tagValue', tags[tagKey])
        .msg(
          'Invalid tag values/delimiters. Please use 4 values separated by a "|". Using default values'
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
    alarmName: `AutoAlarm-${service.toUpperCase()}-${targetGroupName}-${type}-${metricName.toUpperCase()}`,
    threshold,
    durationTime,
    durationPeriods,
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
      for (const classification of Object.values(AlarmClassification)) {
        const {alarmName, threshold, durationTime, durationPeriods} =
          await getTGAlarmConfig(
            targetGroupName,
            classification as AlarmClassification,
            'tg',
            metricName,
            tags
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

  if (targetGroupArn && (eventType === 'Create' || eventType === 'TagChange')) {
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
