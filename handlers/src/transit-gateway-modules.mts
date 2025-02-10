import {EC2Client, DescribeTagsCommand} from '@aws-sdk/client-ec2';
import * as logging from '@nr1e/logging';
import {Tag} from './types.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {AlarmClassification} from './enums.mjs';
import {
  getCWAlarmsForInstance,
  deleteExistingAlarms,
  buildAlarmName,
  handleAnomalyAlarms,
  handleStaticAlarms,
} from './alarm-tools.mjs';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {MetricAlarmConfigs, parseMetricAlarmOptions} from './alarm-config.mjs';

const log: logging.Logger = logging.newLogger('transit-gateway-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const ec2Client: EC2Client = new EC2Client({
  region: region,
  retryStrategy: retryStrategy,
});
const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region: region,
  retryStrategy: retryStrategy,
});

const metricConfigs = MetricAlarmConfigs['TransitGateway'];

export async function fetchTransitGatewayTags(
  transitGatewayId: string,
): Promise<{[key: string]: string}> {
  try {
    const response = await ec2Client.send(
      new DescribeTagsCommand({
        Filters: [{Name: 'resource-id', Values: [transitGatewayId]}],
      }),
    );

    const tags: {[key: string]: string} = {};
    response.Tags?.forEach((tag) => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .info()
      .str('function', 'fetchTransitGatewayTags')
      .str('transitGatewayId', transitGatewayId)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched tags for Transit Gateway');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchTransitGatewayTags')
      .err(error)
      .msg('Error fetching tags for Transit Gateway');
    return {};
  }
}

async function checkAndManageTransitGatewayStatusAlarms(
  transitGatewayId: string,
  tags: Tag,
): Promise<void> {
  log
    .info()
    .str('function', 'checkAndManageTransitGatewayStaticAlarms')
    .str('transitGatewayId', transitGatewayId)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageTransitGatewayStaticAlarms')
      .str('transitGatewayId', transitGatewayId)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('TGW', transitGatewayId);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageTransitGatewayStaticAlarms')
      .obj('config', config)
      .str('transitGatewayId', transitGatewayId)
      .msg('Processing metric configuration');

    const tagValue = tags[`autoalarm:${config.tagKey}`];
    const updatedDefaults = parseMetricAlarmOptions(
      tagValue || '',
      config.defaults,
    );
    if (config.defaultCreate || tagValue !== undefined) {
      if (config.tagKey.includes('anomaly')) {
        log
          .info()
          .str('function', 'checkAndManageTransitGatewayStaticAlarms')
          .str('transitGatewayId', transitGatewayId)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          'TGW',
          transitGatewayId,
          [{Name: 'TransitGateway', Value: transitGatewayId}],
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageTransitGatewayStaticAlarms')
          .str('transitGatewayId', transitGatewayId)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          'TGW',
          transitGatewayId,
          [{Name: 'TransitGateway', Value: transitGatewayId}],
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageTransitGatewayStaticAlarms')
        .str('transitGatewayId', transitGatewayId)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            'TGW',
            transitGatewayId,
            AlarmClassification.Warning,
            'static',
          ).replace('Warning', ''),
        )
        .msg(
          'No default or overridden alarm values. Marking alarms for deletion.',
        );
    }
  }
  // Delete alarms that are not in the alarmsToKeep set
  const existingAlarms = await getCWAlarmsForInstance('TGW', transitGatewayId);
  const alarmsToDelete = existingAlarms.filter(
    (alarm) => !alarmsToKeep.has(alarm),
  );

  log
    .info()
    .str('function', 'checkAndManageTransitGatewayStaticAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarms that are no longer needed');
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageTransitGatewayStaticAlarms')
    .str('transitGatewayId', transitGatewayId)
    .msg('Finished alarm management process');
}

export async function manageTransitGatewayAlarms(
  transitGatewayId: string,
  tags: Tag,
): Promise<void> {
  await checkAndManageTransitGatewayStatusAlarms(transitGatewayId, tags);
}

export async function manageInactiveTransitGatewayAlarms(
  transitGatewayId: string,
): Promise<void> {
  try {
    await deleteExistingAlarms('TGW', transitGatewayId);
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveTransitGatewayAlarms')
      .err(e)
      .msg(`Error deleting Transit Gateway alarms: ${e}`);
  }
}

function extractTransitGatewayNameFromArn(arn: string): string {
  const regex = /transit-gateway\/([^/]+)$/;
  const match = arn.match(regex);
  return match ? match[1] : '';
}


export async function parseTransitGatewayEventAndCreateAlarms(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any,
): Promise<{
  transitGatewayId: string;
  eventType: string;
  tags: Record<string, string>;
}> {
  let transitGatewayId: string = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      transitGatewayId = event.resources[0];
      eventType = 'TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseTransitGatewayEventAndCreateAlarms')
        .str('eventType', 'TagChange')
        .str('transitGatewayId', transitGatewayId)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');
      break;

    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateTransitGateway':
          transitGatewayId =
            event.detail.responseElements?.transitGateway?.transitGatewayId;
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseTransitGatewayEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('transitGatewayId', transitGatewayId)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateTransitGateway event');
          if (transitGatewayId) {
            tags = await fetchTransitGatewayTags(transitGatewayId);
            log
              .info()
              .str('function', 'parseTransitGatewayEventAndCreateAlarms')
              .str('transitGatewayId', transitGatewayId)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new Transit Gateway');
          } else {
            log
              .warn()
              .str('function', 'parseTransitGatewayEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('TransitGatewayId not found in CreateTransitGateway event');
          }
          break;

        case 'DeleteTransitGateway':
          transitGatewayId = event.detail.requestParameters?.transitGatewayId;
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseTransitGatewayEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('transitGatewayId', transitGatewayId)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteTransitGateway event');
          break;

        default:
          log
            .warn()
            .str('function', 'parseTransitGatewayEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .warn()
        .str('function', 'parseTransitGatewayEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
  }

  const transitGatewayName = extractTransitGatewayNameFromArn(transitGatewayId);
  if (!transitGatewayName) {
    log
      .error()
      .str('function', 'parseTransitGatewayEventAndCreateAlarms')
      .str('transitGatewayId', transitGatewayId)
      .msg('Extracted Transit Gateway name is empty');
  }

  log
    .info()
    .str('function', 'parseTransitGatewayEventAndCreateAlarms')
    .str('transitGatewayId', transitGatewayId)
    .str('eventType', eventType)
    .msg('Finished processing Transit Gateway event');

  if (
    transitGatewayId &&
    (eventType === 'Create' || eventType === 'TagChange')
  ) {
    log
      .info()
      .str('function', 'parseTransitGatewayEventAndCreateAlarms')
      .str('transitGatewayId', transitGatewayId)
      .msg('Starting to manage Transit Gateway alarms');
    await manageTransitGatewayAlarms(transitGatewayName, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseTransitGatewayEventAndCreateAlarms')
      .str('transitGatewayId', transitGatewayId)
      .msg('Starting to manage inactive Transit Gateway alarms');
    await manageInactiveTransitGatewayAlarms(transitGatewayName);
  }

  return {transitGatewayId, eventType, tags};
}
