import {ElastiCacheClient, ListTagsForResourceCommand} from '@aws-sdk/client-elasticache';
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

const log: logging.Logger = logging.getLogger('memcache-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const elasticacheClient: ElastiCacheClient = new ElastiCacheClient({
  region,
  retryStrategy,
});

const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region: region,
  retryStrategy: retryStrategy,
});

const metricConfigs = MetricAlarmConfigs['MemCache'];

export async function fetchMemCacheTags(cacheClusterArn: string): Promise<Tag> {
  try {
    const command = new ListTagsForResourceCommand({ ResourceName: cacheClusterArn });
    const response = await elasticacheClient.send(command);
    const tags: Tag = {};

    response.TagList?.forEach((tag) => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .info()
      .str('function', 'fetchMemCacheTags')
      .str('cacheClusterArn', cacheClusterArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched Memcache cluster tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchMemCacheTags')
      .err(error)
      .str('cacheClusterArn', cacheClusterArn)
      .msg('Error fetching Memcache cluster tags');
    return {};
  }
}

async function checkAndManageMemCacheStatusAlarms(cacheClusterId: string, tags: Tag) {
  log
    .info()
    .str('function', 'checkAndManageMemCacheStatusAlarms')
    .str('CacheClusterId', cacheClusterId)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageMemCacheStatusAlarms')
      .str('CacheClusterId', cacheClusterId)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('CacheClusterId', cacheClusterId);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageMemCacheStatusAlarms')
      .obj('config', config)
      .str('CacheClusterId', cacheClusterId)
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
          .str('function', 'checkAndManageMemCacheStatusAlarms')
          .str('CacheClusterId', cacheClusterId)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          'MC',
          cacheClusterId,
          [{Name: 'CacheClusterId', Value: cacheClusterId}],
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageMemCacheStatusAlarms')
          .str('CacheClusterId', cacheClusterId)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          'MC',
          cacheClusterId,
          [{Name: 'CacheClusterId', Value: cacheClusterId}],
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageMemCacheStatusAlarms')
        .str('CacheClusterId', cacheClusterId)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            'MC',
            cacheClusterId,
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
  const existingAlarms = await getCWAlarmsForInstance('MC', cacheClusterId);
  const alarmsToDelete = existingAlarms.filter(
    (alarm) => !alarmsToKeep.has(alarm),
  );

  log
    .info()
    .str('function', 'checkAndManageMemCacheStatusAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarm that is no longer needed');
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageMemCacheStatusAlarms')
    .str('CacheClusterId', cacheClusterId)
    .msg('Finished alarm management process');
}

export async function manageMemCacheAlarms(
  cacheClusterId: string,
  tags: Tag,
): Promise<void> {
  await checkAndManageMemCacheStatusAlarms(cacheClusterId, tags);
}

export async function manageInactiveMemCacheAlarms(cacheClusterId: string) {
  const cacheClusterName = extractQueueName(cacheClusterId);
  try {
    await deleteExistingAlarms('MC', cacheClusterName);
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveMemCacheAlarms')
      .err(e)
      .msg(`Error deleting MemCache alarms: ${e}`);
    throw new Error(`Error deleting MemCache alarms: ${e}`);
  }
}

function extractQueueName(cacheClusterId: string): string {
  const parts = cacheClusterId.split('/');
  return parts[parts.length - 1];
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseMemCacheEventAndCreateAlarms(event: any): Promise<{
  cacheClusterId: string;
  eventType: string;
  tags: Record<string, string>;
}> {
  let cacheClusterId: string = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateCacheCluster':
          cacheClusterId = event.detail.responseElements?.cacheClusterId;
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseMemCacheEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('CacheClusterId', cacheClusterId)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateQueue event');
          if (cacheClusterId) {
            tags = await fetchMemCacheTags(cacheClusterId);
            log
              .info()
              .str('function', 'parseMemCacheEventAndCreateAlarms')
              .str('CacheClusterId', cacheClusterId)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new SQS queue');
          } else {
            log
              .warn()
              .str('function', 'parseMemCacheEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('CacheClusterId not found in CreateCacheCluster event');
          }
          break;

        case 'DeleteCacheCluster':
          cacheClusterId = event.detail.requestParameters?.cacheClusterId;
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseMemCacheEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('cacheClusterId', cacheClusterId)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteCacheCluster event');
          break;

        case 'TagQueue':
          eventType = 'TagChange';
          cacheClusterId = event.detail.requestParameters?.queueUrl;
          log
            .info()
            .str('function', 'parseMemCacheEventAndCreateAlarms')
            .str('eventType', 'TagQueue')
            .str('CacheClusterId', cacheClusterId)
            .str('requestId', event.detail.requestID)
            .msg('Processing TagQueue event');
          if (cacheClusterId) {
            tags = await fetchMemCacheTags(cacheClusterId);
            log
              .info()
              .str('function', 'parseSQSEventAndCreateAlarms')
              .str('CacheClusterId', cacheClusterId)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new SQS queue');
          } else {
            log
              .warn()
              .str('function', 'parseSQSEventAndCreateAlarms')
              .str('eventType', 'TagQueue')
              .msg('QueueUrl not found in TagQueue event');
          }
          break;

        case 'UntagQueue':
          eventType = 'TagChange';
          cacheClusterId = event.detail.requestParameters?.queueUrl;
          log
            .info()
            .str('function', 'parseSQSEventAndCreateAlarms')
            .str('eventType', 'UntagQueue')
            .str('cacheClusterId', cacheClusterId)
            .msg('Processing UntagQueue event');
          if (cacheClusterId) {
            tags = await fetchMemCacheTags(cacheClusterId);
            log
              .info()
              .str('function', 'parseSQSEventAndCreateAlarms')
              .str('queueUrl', cacheClusterId)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new SQS queue');
          } else {
            log
              .warn()
              .str('function', 'parseSQSEventAndCreateAlarms')
              .str('eventType', 'UnTagQueue')
              .msg('QueueUrl not found in TagQueue event');
          }
          break;

        default:
          log
            .warn()
            .str('function', 'parseSQSEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .warn()
        .str('function', 'parseSQSEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
  }

  const queueName = extractQueueName(cacheClusterId);
  if (!queueName) {
    log
      .error()
      .str('function', 'parseSQSEventAndCreateAlarms')
      .str('queueUrl', cacheClusterId)
      .msg('Extracted queue name is empty');
  }

  log
    .info()
    .str('function', 'parseSQSEventAndCreateAlarms')
    .str('queueUrl', cacheClusterId)
    .str('eventType', eventType)
    .msg('Finished processing SQS event');

  if (cacheClusterId && (eventType === 'Create' || eventType === 'TagChange')) {
    log
      .info()
      .str('function', 'parseSQSEventAndCreateAlarms')
      .str('queueUrl', cacheClusterId)
      .msg('Starting to manage SQS alarms');
    await manageMemCacheAlarms(cacheClusterId, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseSQSEventAndCreateAlarms')
      .str('queueUrl', cacheClusterId)
      .msg('Starting to manage inactive SQS alarms');
    await manageInactiveMemCacheAlarms(cacheClusterId);
  }

  return {cacheClusterId, eventType, tags};
}
