import {DescribeTagsCommand, ElasticLoadBalancingV2Client,} from '@aws-sdk/client-elastic-load-balancing-v2';
import * as logging from '@nr1e/logging';
import {Tag} from './types.mjs';
import {AlarmClassification} from './enums.mjs';
import {CloudWatchClient, DeleteAlarmsCommand} from '@aws-sdk/client-cloudwatch';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {
  createOrUpdateAnomalyDetectionAlarm,
  createOrUpdateCWAlarm,
  deleteCWAlarm,
  doesAlarmExist,
  getCWAlarmsForInstance,
} from './alarm-tools.mjs';
import {MetricAlarmConfigs, parseMetricAlarmOptions} from "./alarm-config.mjs";

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

const metricConfigs = MetricAlarmConfigs['ALB'];

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

    if (!config.defaultCreate && tagValue === undefined) {
      log
        .info()
        .obj('config', config)
        .msg('Not default and tag value is undefined. Checking if Alarms exist and deleting if they do');
     for (const alarmClassification of Object.values(AlarmClassification)) {
        const alarmName = `AutoAlarm-ALB-${loadBalancerName}-${config.metricName}-${alarmClassification}`;
        if (await doesAlarmExist(alarmName)) {
          log
            .info()
            .str('function', 'checkAndManageALBStatusAlarms')
            .str('alarmName', alarmName)
            .msg('Deleting alarm');
          try {
            await cloudWatchClient.send(
              new DeleteAlarmsCommand({
                AlarmNames: [alarmName],
              }),
            );
          } catch (e) {
            log
              .error()
              .str('function', 'checkAndManageALBStatusAlarms')
              .str('alarmName', alarmName)
              .err(e)
              .msg('Error deleting alarm');
          }
        }
     }
      continue; // not a default and not overridden
    }

    const updatedDefaults = parseMetricAlarmOptions(tagValue || '', config.defaults);

    const alarmNamePrefix = `AutoAlarm-ALB-${loadBalancerName}-${config.metricName}`;
    // Create warning alarm
    if (updatedDefaults.warningThreshold && !config.tagKey.includes('anomaly')) {
      log
        .info()
        .str('function', 'checkAndManageALBStatusAlarms')
        .str('Alarm Name', `${alarmNamePrefix}-Warning}`)
        .msg('Creating or updating static threshold alarm');
      await createOrUpdateCWAlarm(
        `${alarmNamePrefix}-Warning`,
        loadBalancerName,
        updatedDefaults.comparisonOperator,
        updatedDefaults.warningThreshold,
        updatedDefaults.period,
        updatedDefaults.evaluationPeriods,
        config.metricName,
        config.metricNamespace,
        [{Name: 'LoadBalancer', Value: loadBalancerName}],
        AlarmClassification.Warning,
        updatedDefaults.missingDataTreatment,
        updatedDefaults.statistic,
      );
    } else if (updatedDefaults.warningThreshold && config.tagKey.includes('anomaly')) {
      log
        .info()
        .str('function', 'checkAndManageALBStatusAlarms')
        .str('Alarm Name', `${alarmNamePrefix}-Warning}`)
        .msg('Creating or updating anomaly alarm');
      await createOrUpdateAnomalyDetectionAlarm(
        `${alarmNamePrefix}-Warning`,
        updatedDefaults.comparisonOperator,
        [{Name: 'LoadBalancer', Value: loadBalancerName}],
        config.metricName,
        config.metricNamespace,
        updatedDefaults.statistic,
        updatedDefaults.period,
        updatedDefaults.evaluationPeriods,
        AlarmClassification.Warning,
        updatedDefaults.missingDataTreatment,
        updatedDefaults.warningThreshold,
      );
    } else if (await doesAlarmExist(`${alarmNamePrefix}-Warning`)) {
      await cloudWatchClient.send(
        new DeleteAlarmsCommand({
          AlarmNames: [`${alarmNamePrefix}-Warning`],
        }),
      );
    }

    // Create critical alarm
    if (updatedDefaults.criticalThreshold && !config.tagKey.includes('anomaly')) {
      log
        .info()
        .str('function', 'checkAndManageALBStatusAlarms')
        .str('Alarm Name', `${alarmNamePrefix}-Critical}`)
        .msg('Creating or updating static threshold alarm');
        await createOrUpdateCWAlarm(
          `${alarmNamePrefix}-Critical`,
          loadBalancerName,
          updatedDefaults.comparisonOperator,
          updatedDefaults.criticalThreshold,
          updatedDefaults.period,
          updatedDefaults.evaluationPeriods,
          config.metricName,
          config.metricNamespace,
          [{Name: 'LoadBalancer', Value: loadBalancerName}],
          AlarmClassification.Critical,
          updatedDefaults.missingDataTreatment,
          updatedDefaults.statistic,
        );
    } else if (updatedDefaults.criticalThreshold && config.tagKey.includes('anomaly')) {
      log
        .info()
        .str('function', 'checkAndManageALBStatusAlarms')
        .str('Alarm Name', `${alarmNamePrefix}-Critical}`)
        .msg('Creating or updating anomaly alarm');
      await createOrUpdateAnomalyDetectionAlarm(
        `${alarmNamePrefix}-Critical`,
        updatedDefaults.comparisonOperator,
        [{Name: 'LoadBalancer', Value: loadBalancerName}],
        config.metricName,
        config.metricNamespace,
        updatedDefaults.statistic,
        updatedDefaults.period,
        updatedDefaults.evaluationPeriods,
        AlarmClassification.Critical,
        updatedDefaults.missingDataTreatment,
        updatedDefaults.criticalThreshold,
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
