import {
  CloudFrontClient,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-cloudfront';
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

const log: logging.Logger = logging.newLogger('cloudfront-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const cloudFrontClient: CloudFrontClient = new CloudFrontClient({
  region: region,
  retryStrategy: retryStrategy,
});
const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region: region,
  retryStrategy: retryStrategy,
});

const metricConfigs = MetricAlarmConfigs['CloudFront'];

export async function fetchCloudFrontTags(
  distributionArn: string,
): Promise<Tag> {
  try {
    // Use the distributionArn directly as it's already an ARN
    const command = new ListTagsForResourceCommand({Resource: distributionArn});
    const response = await cloudFrontClient.send(command);

    const tags: {[key: string]: string} = {};
    response.Tags?.Items?.forEach((tag) => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .info()
      .str('function', 'fetchCloudFrontTags')
      .str('distributionArn', distributionArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched tags for CloudFront distribution');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchCloudFrontTags')
      .err(error)
      .str('distributionArn', distributionArn)
      .msg('Error fetching CloudFront tags');

    return {};
  }
}

async function checkAndManageCloudFrontStatusAlarms(
  distributionId: string,
  tags: Tag,
): Promise<void> {
  log
    .info()
    .str('function', 'checkAndManageCloudFrontStatusAlarms')
    .str('distributionId', distributionId)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageCloudFrontStatusAlarms')
      .str('distributionId', distributionId)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('CF', distributionId);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageCloudFrontStatusAlarms')
      .obj('config', config)
      .str('distributionId', distributionId)
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
          .str('function', 'checkAndManageCloudFrontStatusAlarms')
          .str('distributionId', distributionId)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          'CF',
          distributionId,
          [
            {Name: 'DistributionId', Value: distributionId},
            {Name: 'Region', Value: 'Global'},
          ],
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageCloudFrontStatusAlarms')
          .str('distributionId', distributionId)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          'CF',
          distributionId,
          [
            {Name: 'DistributionId', Value: distributionId},
            {Name: 'Region', Value: 'Global'},
          ],
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageCloudFrontStatusAlarms')
        .str('distributionId', distributionId)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            'CF',
            distributionId,
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
  const existingAlarms = await getCWAlarmsForInstance('CF', distributionId);
  const alarmsToDelete = existingAlarms.filter(
    (alarm) => !alarmsToKeep.has(alarm),
  );

  log
    .info()
    .str('function', 'checkAndManageCloudFrontStatusAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarms that are no longer needed');
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageCloudFrontStatusAlarms')
    .str('distributionId', distributionId)
    .msg('Finished alarm management process');
}

export async function manageCloudFrontAlarms(
  distributionId: string,
  tags: Tag,
): Promise<void> {
  await checkAndManageCloudFrontStatusAlarms(distributionId, tags);
}

export async function manageInactiveCloudFrontAlarms(
  distributionId: string,
): Promise<void> {
  try {
    await deleteExistingAlarms('CF', distributionId);
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveCloudFrontAlarms')
      .err(e)
      .msg(`Error deleting CloudFront alarms: ${e}`);
  }
}

function extractDistributionIdFromArn(arn: string): string {
  const regex = /distribution\/([^/]+)$/;
  const match = arn.match(regex);
  return match ? match[1] : '';
}

export async function parseCloudFrontEventAndCreateAlarms(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any,
): Promise<{
  distributionArn: string;
  eventType: string;
  tags: Record<string, string>;
}> {
  let distributionArn: string = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      distributionArn = event.resources[0];
      eventType = 'TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseCloudFrontEventAndCreateAlarms')
        .str('eventType', 'TagChange')
        .str('distributionArn', distributionArn)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');
      break;

    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateDistribution':
          distributionArn = event.detail.responseElements?.distribution?.aRN;
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseCloudFrontEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('distributionArn', distributionArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateDistribution event');
          if (distributionArn) {
            tags = await fetchCloudFrontTags(distributionArn);
            log
              .info()
              .str('function', 'parseCloudFrontEventAndCreateAlarms')
              .str('distributionArn', distributionArn)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new CreateDistribution event');
          } else {
            log
              .warn()
              .str('function', 'parseCloudFrontEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('Distribution ARN not found in CreateDistribution event');
          }
          break;

        case 'DeleteDistribution':
          distributionArn = event.detail.responseElements?.distribution?.aRN;
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseCloudFrontEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('distributionArn', distributionArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteDistribution event');
          break;

        default:
          log
            .warn()
            .str('function', 'parseCloudFrontEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .warn()
        .str('function', 'parseCloudFrontEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
  }

  // Extract the distribution ID from the ARN
  const distributionId = extractDistributionIdFromArn(distributionArn);
  if (!distributionId) {
    log
      .error()
      .str('function', 'parseCloudFrontEventAndCreateAlarms')
      .str('distributionArn', distributionArn)
      .msg('Extracted CloudFront distribution ID is empty');
  }

  log
    .info()
    .str('function', 'parseCloudFrontEventAndCreateAlarms')
    .str('distributionArn', distributionArn)
    .str('eventType', eventType)
    .msg('Finished processing CloudFront event');

  if (
    distributionArn &&
    (eventType === 'Create' || eventType === 'TagChange')
  ) {
    log
      .info()
      .str('function', 'parseCloudFrontEventAndCreateAlarms')
      .str('distributionArn', distributionArn)
      .msg('Starting to manage CloudFront alarms');
    await manageCloudFrontAlarms(distributionId, tags); // Use distributionId
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseCloudFrontEventAndCreateAlarms')
      .str('distributionArn', distributionArn)
      .msg('Starting to manage inactive CloudFront alarms');
    await manageInactiveCloudFrontAlarms(distributionId); // Use distributionId
  }

  return {distributionArn, eventType, tags};
}
