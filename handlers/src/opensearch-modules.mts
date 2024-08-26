import {OpenSearchClient, ListTagsCommand} from '@aws-sdk/client-opensearch';
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

const log: logging.Logger = logging.getLogger('opensearch-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const openSearchClient: OpenSearchClient = new OpenSearchClient({
  region,
  retryStrategy,
});

const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region: region,
  retryStrategy: retryStrategy,
});

const metricConfigs = MetricAlarmConfigs['OpenSearch'];

export async function fetchOpenSearchTags(domainArn: string): Promise<Tag> {
  try {
    const command = new ListTagsCommand({
      ARN: domainArn,
    });
    const response = await openSearchClient.send(command);
    const tags: Tag = {};

    response.TagList?.forEach((tag) => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .info()
      .str('function', 'fetchOpenSearchTags')
      .str('domainArn', domainArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched OpenSearch tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchOpenSearchTags')
      .err(error)
      .str('domainArn', domainArn)
      .msg('Error fetching OpenSearch tags');
    return {};
  }
}

async function checkAndManageOpenSearchStatusAlarms(
  domainName: string,
  accountID: string,
  tags: Tag,
) {
  log
    .info()
    .str('function', 'checkAndManageOSStatusAlarms')
    .str('DomainName', domainName)
    .str('ClientId', accountID)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageOSStatusAlarms')
      .str('DomainName', domainName)
      .str('ClientId', accountID)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('OS', domainName);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageOSStatusAlarms')
      .obj('config', config)
      .str('DomainName', domainName)
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
          .str('function', 'checkAndManageOSStatusAlarms')
          .str('DomainName', domainName)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          'OS',
          domainName,
          [
            {Name: 'DomainName', Value: domainName},
            {Name: 'ClientId', Value: accountID},
          ],
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageOSStatusAlarms')
          .str('DomainName', domainName)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          'OS',
          domainName,
          [
            {Name: 'DomainName', Value: domainName},
            {Name: 'ClientId', Value: accountID},
          ],
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageOSStatusAlarms')
        .str('DomainName', domainName)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            'OS',
            domainName,
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
  const existingAlarms = await getCWAlarmsForInstance('OS', domainName);
  const alarmsToDelete = existingAlarms.filter(
    (alarm) => !alarmsToKeep.has(alarm),
  );

  log
    .info()
    .str('function', 'checkAndManageOSStatusAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarm that is no longer needed');
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageOSStatusAlarms')
    .str('DomainName', domainName)
    .msg('Finished alarm management process');
}

export async function manageOpenSearchAlarms(
  domainName: string,
  accountID: string,
  tags: Tag,
): Promise<void> {
  await checkAndManageOpenSearchStatusAlarms(domainName, accountID, tags);
}

export async function manageInactiveOpenSearchAlarms(domainName: string) {
  try {
    await deleteExistingAlarms('OS', domainName);
  } catch (e) {
    log.error().err(e).msg(`Error deleting OpenSearch alarms: ${e}`);
    throw new Error(`Error deleting OpenSearch alarms: ${e}`);
  }
}

function extractOSDomainNameFromArn(arn: string): string {
  const regex = /domain\/([^/]+)$/;
  const match = arn.match(regex);
  return match ? match[1] : '';
}

function extractAccountIdFromArn(arn: string): string {
  const parts = arn.split(':');
  return parts.length > 4 ? parts[4] : '';
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseOSEventAndCreateAlarms(event: any): Promise<{
  domainArn: string;
  accountID: string;
  eventType: string;
  tags: Record<string, string>;
}> {
  let domainArn: string = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      domainArn = event.resources[0];
      eventType = 'Domain TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseOSEventAndCreateAlarms')
        .str('eventType', eventType)
        .str('domainArn', domainArn)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');
      break;

    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateDomain':
          domainArn = event.detail.responseElements?.domain?.arn; //deprecated domain convention still in use in event. Safe to ignore.
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseOSEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('domainArn', domainArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateDomain event');
          if (domainArn) {
            tags = await fetchOpenSearchTags(domainArn);
            log
              .info()
              .str('function', 'parseOSEventAndCreateAlarms')
              .str('domainArn', domainArn)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new domain');
          } else {
            log
              .warn()
              .str('function', 'parseOSEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('DomainArn not found in CreateDomain event');
          }
          break;

        case 'DeleteDomain':
          domainArn = event.detail.requestParameters?.domainArn;
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseOSEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('domainArn', domainArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteDomain event');
          break;

        default:
          log
            .warn()
            .str('function', 'parseOSEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .warn()
        .str('function', 'parseOSEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
  }

  const domainName = extractOSDomainNameFromArn(domainArn);
  const accountID = extractAccountIdFromArn(domainArn);
  if (!domainName) {
    log
      .error()
      .str('function', 'parseOSEventAndCreateAlarms')
      .str('domainArn', domainArn)
      .msg('Extracted domain name is empty');
  }

  log
    .info()
    .str('function', 'parseOSEventAndCreateAlarms')
    .str('domainArn', domainArn)
    .str('eventType', eventType)
    .msg('Finished processing domain event');

  if (
    domainArn &&
    (eventType === 'Create' || eventType === 'Domain TagChange')
  ) {
    log
      .info()
      .str('function', 'parseOSEventAndCreateAlarms')
      .str('domainArn', domainArn)
      .msg('Starting to manage domain alarms');
    await manageOpenSearchAlarms(domainName, accountID, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseOSEventAndCreateAlarms')
      .str('domainArn', domainArn)
      .msg('Starting to manage inactive domain alarms');
    await manageInactiveOpenSearchAlarms(domainName);
  }

  return {domainArn, accountID, eventType, tags};
}
