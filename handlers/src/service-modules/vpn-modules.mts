import {EC2Client, DescribeTagsCommand} from '@aws-sdk/client-ec2';
import * as logging from '@nr1e/logging';
import {Tag} from '#types/module-types.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {AlarmClassification} from '#types/enums.mjs';
import {
  getCWAlarmsForInstance,
  deleteExistingAlarms,
  buildAlarmName,
  handleAnomalyAlarms,
  handleStaticAlarms,
} from '#cloudwatch-alarm-utils/alarm-tools.mjs';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  AlarmConfigs,
  parseMetricAlarmOptions,
} from '#cloudwatch-alarm-utils/alarm-config.mjs';

const log: logging.Logger = logging.getLogger('vpn-modules');
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

const metricConfigs = AlarmConfigs['VPN'];

export async function fetchVpnTags(
  vpnId: string,
): Promise<{[key: string]: string}> {
  try {
    const response = await ec2Client.send(
      new DescribeTagsCommand({
        Filters: [{Name: 'resource-id', Values: [vpnId]}],
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
      .str('function', 'fetchVpnTags')
      .str('vpnId', vpnId)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched tags for VPN');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchVpnTags')
      .err(error)
      .msg('Error fetching tags for VPN');
    return {};
  }
}

async function checkAndManageVpnStatusAlarms(
  vpnId: string,
  tags: Tag,
): Promise<void> {
  log
    .info()
    .str('function', 'checkAndManageVpnStatusAlarms')
    .str('vpnId', vpnId)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageVpnStatusAlarms')
      .str('vpnId', vpnId)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('VPN', vpnId);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageVpnStatusAlarms')
      .obj('config', config)
      .str('vpnId', vpnId)
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
          .str('function', 'checkAndManageVpnStatusAlarms')
          .str('vpnId', vpnId)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          'VPN',
          vpnId,
          [{Name: 'VpnId', Value: vpnId}],
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageVpnStatusAlarms')
          .str('vpnId', vpnId)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          'VPN',
          vpnId,
          [{Name: 'VpnId', Value: vpnId}],
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageVpnStatusAlarms')
        .str('vpnId', vpnId)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            'VPN',
            vpnId,
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
  const existingAlarms = await getCWAlarmsForInstance('VPN', vpnId);
  const alarmsToDelete = existingAlarms.filter(
    (alarm) => !alarmsToKeep.has(alarm),
  );

  log
    .info()
    .str('function', 'checkAndManageVpnStatusAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarms that are no longer needed');
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageVpnStatusAlarms')
    .str('vpnId', vpnId)
    .msg('Finished alarm management process');
}

export async function manageVpnAlarms(vpnId: string, tags: Tag): Promise<void> {
  await checkAndManageVpnStatusAlarms(vpnId, tags);
}

export async function manageInactiveVpnAlarms(vpnId: string): Promise<void> {
  try {
    await deleteExistingAlarms('VPN', vpnId);
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveVpnAlarms')
      .err(e)
      .msg(`Error deleting VPN alarms: ${e}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseVpnEventAndCreateAlarms(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any,
): Promise<{
  vpnId: string;
  eventType: string;
  tags: Record<string, string>;
}> {
  let vpnId: string = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      vpnId = event.resources[0];
      eventType = 'TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseVpnEventAndCreateAlarms')
        .str('eventType', 'TagChange')
        .str('vpnId', vpnId)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');
      break;

    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateVpnConnection':
          vpnId = event.detail.responseElements?.vpnConnection?.vpnConnectionId;
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseVpnEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('vpnId', vpnId)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateVpnConnection event');
          if (vpnId) {
            tags = await fetchVpnTags(vpnId);
            log
              .info()
              .str('function', 'parseVpnEventAndCreateAlarms')
              .str('vpnId', vpnId)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new CreateVpnConnection event');
          } else {
            log
              .warn()
              .str('function', 'parseVpnEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('vpnId not found in CreateVPNConnection event');
          }
          break;

        case 'DeleteVpnConnection':
          vpnId = event.detail.requestParameters?.vpnConnectionId;
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseVpnEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('vpnId', vpnId)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteVpnConnection event');
          break;

        default:
          log
            .warn()
            .str('function', 'parseVpnEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .warn()
        .str('function', 'parseVpnEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
  }

  if (!vpnId) {
    log
      .error()
      .str('function', 'parseVpnEventAndCreateAlarms')
      .str('vpnId', vpnId)
      .msg('Vpn Id is empty');
  }

  log
    .info()
    .str('function', 'parseVpnEventAndCreateAlarms')
    .str('vpnId', vpnId)
    .str('eventType', eventType)
    .msg('Finished processing VPN event');

  if (vpnId && (eventType === 'Create' || eventType === 'TagChange')) {
    log
      .info()
      .str('function', 'parseVpnEventAndCreateAlarms')
      .str('vpnId', vpnId)
      .msg('Starting to manage VPN alarms');
    await manageVpnAlarms(vpnId, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseVpnEventAndCreateAlarms')
      .str('vpnId', vpnId)
      .msg('Starting to manage inactive VPN alarms');
    await manageInactiveVpnAlarms(vpnId);
  }

  return {vpnId, eventType, tags};
}
