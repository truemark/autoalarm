import {
  ListTagsForResourceCommand,
  Route53ResolverClient,
} from '@aws-sdk/client-route53resolver'; // ES Module import
import * as logging from '@nr1e/logging';
import {Tag} from './types.mjs';
import {AlarmClassification} from './enums.mjs';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {
  deleteExistingAlarms,
  buildAlarmName,
  handleAnomalyAlarms,
  handleStaticAlarms,
  getCWAlarmsForInstance,
} from './alarm-tools.mjs';
import {MetricAlarmConfigs, parseMetricAlarmOptions} from './alarm-config.mjs';

const log: logging.Logger = logging.newLogger('route53-resolver-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const route53ResolverClient = new Route53ResolverClient({
  region,
  retryStrategy,
});
const cloudWatchClient = new CloudWatchClient({
  region,
  retryStrategy,
});

const metricConfigs = MetricAlarmConfigs['R53ResolverEndpoint'];

export async function fetchR53ResolverTags(endpointId: string): Promise<Tag> {
  try {
    const command = new ListTagsForResourceCommand({
      ResourceArn: endpointId,
    });
    const response = await route53ResolverClient.send(command);
    const tags: Tag = {};

    response.Tags?.forEach((tag) => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .info()
      .str('function', 'fetchR53ResolverTags')
      .str('resolverId', endpointId)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched tags for R53 Resolver Endpoint');
    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchR53ResolverTags')
      .str('resolverId', endpointId)
      .err(error)
      .msg('Error fetching tags for R53 Resolver Endpoint');
    return {};
  }
}

async function checkAndManageR53ResolverStatusAlarms(
  endpointId: string,
  tags: Tag,
) {
  log
    .info()
    .str('function', 'checkAndManageR53ResolverStatusAlarms')
    .str('EndpointId', endpointId)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageR53ResolverStatusAlarms')
      .str('EndpointId', endpointId)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('R53R', endpointId);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageR53ResolverStatusAlarms')
      .obj('config', config)
      .str('EndpointId', endpointId)
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
          .str('function', 'checkAndManageR53ResolverStatusAlarms')
          .str('EndpointId', endpointId)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          'R53R',
          endpointId,
          [{Name: 'EndpointId', Value: endpointId}],
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageR53ResolverStatusAlarms')
          .str('EndpointId', endpointId)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          'R53R',
          endpointId,
          [{Name: 'EndpointId', Value: endpointId}],
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageR53ResolverStatusAlarms')
        .str('EndpointId', endpointId)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            'R53R',
            endpointId,
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
  const existingAlarms = await getCWAlarmsForInstance('R53R', endpointId);
  const alarmsToDelete = existingAlarms.filter(
    (alarm) => !alarmsToKeep.has(alarm),
  );

  log
    .info()
    .str('function', 'checkAndManageR53ResolverStatusAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarms that are no longer needed');
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageR53ResolverStatusAlarms')
    .str('EndpointId', endpointId)
    .msg('Finished alarm management process');
}

export async function manageR53ResolverAlarms(
  endpointId: string,
  tags: Tag,
): Promise<void> {
  await checkAndManageR53ResolverStatusAlarms(endpointId, tags);
}

export async function manageInactiveR53ResolverAlarms(endpointId: string) {
  try {
    await deleteExistingAlarms('R53R', endpointId);
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveR53ResolverAlarms')
      .err(e)
      .msg(`Error deleting R53R alarms: ${e}`);
    throw new Error(`Error deleting R53R alarms: ${e}`);
  }
}

function extractR53ResolverNameFromArn(arn: string): string {
  const regex = /resolver-endpoint\/([^/]+)$/;
  const match = arn.match(regex);
  return match ? match[1] : '';
}

export async function parseR53ResolverEventAndCreateAlarms(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any,
): Promise<{
  endpointId: string;
  eventType: string;
  tags: Record<string, string>;
}> {
  let endpointId: string = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      endpointId = event.resources[0];
      eventType = 'TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseR53ResolverEventAndCreateAlarms')
        .str('eventType', 'TagChange')
        .str('endpointId', endpointId)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');
      break;

    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateResolverEndpoint':
          endpointId = event.detail.responseElements?.resolverEndpoint?.id;
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseR53ResolverEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('endpointId', endpointId)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateResolverEndpoint event');
          if (endpointId) {
            tags = await fetchR53ResolverTags(endpointId);
            log
              .info()
              .str('function', 'parseR53ResolverEventAndCreateAlarms')
              .str('endpointId', endpointId)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new Route 53 Resolver endpoint');
          } else {
            log
              .warn()
              .str('function', 'parseR53ResolverEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('Endpoint ID not found in CreateResolverEndpoint event');
          }
          break;

        case 'DeleteResolverEndpoint':
          endpointId = event.detail.requestParameters?.resolverEndpointId;
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseR53ResolverEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('endpointId', endpointId)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteResolverEndpoint event');
          break;

        default:
          log
            .warn()
            .str('function', 'parseR53ResolverEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .warn()
        .str('function', 'parseR53ResolverEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
  }

  // Extract the Resolver name from the ARN
  const resolverName = extractR53ResolverNameFromArn(endpointId);
  if (!resolverName) {
    log
      .error()
      .str('function', 'parseR53ResolverEventAndCreateAlarms')
      .str('endpointId', endpointId)
      .msg('Extracted Route 53 Resolver name is empty');
  }

  log
    .info()
    .str('function', 'parseR53ResolverEventAndCreateAlarms')
    .str('endpointId', endpointId)
    .str('eventType', eventType)
    .msg('Finished processing Route 53 Resolver event');

  if (endpointId && (eventType === 'Create' || eventType === 'TagChange')) {
    log
      .info()
      .str('function', 'parseR53ResolverEventAndCreateAlarms')
      .str('endpointId', endpointId)
      .msg('Starting to manage Route 53 Resolver alarms');
    await manageR53ResolverAlarms(resolverName, tags); // Use resolverName
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseR53ResolverEventAndCreateAlarms')
      .str('endpointId', endpointId)
      .msg('Starting to manage inactive Route 53 Resolver alarms');
    await manageInactiveR53ResolverAlarms(resolverName); // Use resolverName
  }

  return {endpointId, eventType, tags};
}
