import * as logging from '@nr1e/logging';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchLogsClient,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {SQSRecord} from 'aws-lambda';
import {Tag} from '../types/index.mjs';
import {
  handleAnomalyAlarms,
  handleStaticAlarms,
  getCWAlarmsForInstance,
  parseMetricAlarmOptions,
  deleteExistingAlarms,
} from '../alarm-configs/utils/index.mjs';
import {LOGGROUP_CONFIGS} from '../alarm-configs/loggroup-configs.mjs';
import {Dimension} from '../types/module-types.mjs';

const log: logging.Logger = logging.getLogger('loggroup-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);

const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region,
  retryStrategy,
});

const metricConfigs = LOGGROUP_CONFIGS;

export async function fetchLogGroupTags(
  arn: string,
): Promise<Record<string, string>> {
  const resourceArn = arn.replace(/:\*$/, '');

  log
    .debug()
    .str('function', 'fetchLogGroupTags')
    .str('inputArn', arn)
    .str('resourceArn', resourceArn)
    .msg('Calling ListTagsForResource');

  const resp = await logsClient.send(
    new ListTagsForResourceCommand({
      resourceArn,
    }),
  );

  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(resp.tags ?? {})) {
    if (key.startsWith('autoalarm:')) {
      tags[key] = value ?? '';
    }
  }

  return tags;
}

/**
 * High-level orchestration function for reconciling log group alarms.
 *
 * Behavior:
 * - Logs that alarm management has started for the log group.
 * - Calls createOrUpdateLogGroupAlarms to ensure all desired alarms exist
 *   and are configured correctly.
 * - Calls deleteUnneededLogGroupAlarms to delete any leftover/obsolete alarms.
 * - Logs how many alarms are being managed/kept.
 *
 * @param logGroupArn  ARN of the log group being managed.
 * @param logGroupName Name of the log group, used as metric dimension.
 * @param tags         Map of autoalarm:* tags for this log group.
 */
async function manageLogGroupAlarms(
  logGroupArn: string,
  logGroupName: string,
  tags: Tag,
): Promise<void> {
  log
    .info()
    .str('function', 'manageLogGroupAlarms')
    .str('logGroupArn', logGroupArn)
    .str('logGroupName', logGroupName)
    .msg('Managing log group alarms');

  const alarmsToKeep = await createOrUpdateLogGroupAlarms(
    logGroupArn,
    logGroupName,
    tags,
  );

  await deleteUnneededLogGroupAlarms(logGroupArn, alarmsToKeep);

  log
    .info()
    .str('function', 'manageLogGroupAlarms')
    .str('logGroupArn', logGroupArn)
    .num('alarmsManaged', alarmsToKeep.size)
    .msg('Log group alarm management complete');
}

/**
 * Create or update CloudWatch alarms for a given log group based on
 * AutoAlarm metric configs and the log group's autoalarm:* tags.
 *
 * Behavior:
 * - Builds the standard LogGroupName dimension.
 * - Iterates over all LOGGROUP_CONFIGS.
 * - For each config:
 *   - Looks for a matching tag (autoalarm:<tagKey>) on the log group.
 *   - Skips if config.defaultCreate is false and there is no tag override.
 *   - Parses tag-supplied overrides into metric alarm options.
 *   - Chooses anomaly vs static alarm handler.
 *   - Calls the handler to create/update alarms.
 *   - Adds all resulting alarm names to the alarmsToKeep set.
 *
 * @param logGroupArn  Full ARN of the CloudWatch Logs log group.
 * @param logGroupName Name of the log group (used as metric dimension).
 * @param tags         Map of autoalarm:* tags for this log group.
 * @returns Set of alarm names that should exist for this log group.
 */
async function createOrUpdateLogGroupAlarms(
  logGroupArn: string,
  logGroupName: string,
  tags: Tag,
): Promise<Set<string>> {
  const alarmsToKeep = new Set<string>();

  const dimensions: Dimension[] = [{Name: 'LogGroupName', Value: logGroupName}];

  for (const config of metricConfigs) {
    const tagValue = tags[`autoalarm:${config.tagKey}`];

    if (!config.defaultCreate && tagValue === undefined) {
      continue;
    }

    const updatedDefaults = parseMetricAlarmOptions(
      tagValue || '',
      config.defaults,
    );

    const isAnomaly = config.tagKey.includes('anomaly') || config.anomaly;
    const alarmHandler = isAnomaly ? handleAnomalyAlarms : handleStaticAlarms;

    const alarmNames = await alarmHandler(
      config,
      'Logs',
      logGroupArn,
      dimensions,
      updatedDefaults,
    );

    alarmNames.forEach((name) => alarmsToKeep.add(name));

    log
      .debug()
      .str('function', 'createOrUpdateLogGroupAlarms')
      .str('logGroupName', logGroupName)
      .str('metricType', config.tagKey)
      .num('alarmsCreated', alarmNames.length)
      .msg('Processed log group metric configuration');
  }

  return alarmsToKeep;
}

/**
 * Delete any CloudWatch alarms associated with this log group that are
 * no longer required based on the latest config and tags.
 *
 * Behavior:
 * - Lists existing alarms for the log group using getCWAlarmsForInstance.
 * - Computes the difference between existing alarms and alarmsToKeep.
 * - If there are obsolete alarms, issues a DeleteAlarmsCommand.
 *
 * @param logGroupArn  ARN of the log group whose alarms are being reconciled.
 * @param alarmsToKeep Set of alarm names that should remain after cleanup.
 */
async function deleteUnneededLogGroupAlarms(
  logGroupArn: string,
  alarmsToKeep: Set<string>,
): Promise<void> {
  const existingAlarms = await getCWAlarmsForInstance('Logs', logGroupArn);
  const alarmsToDelete = existingAlarms.filter(
    (alarm) => !alarmsToKeep.has(alarm),
  );

  if (alarmsToDelete.length === 0) {
    return;
  }

  await cloudWatchClient.send(
    new DeleteAlarmsCommand({AlarmNames: alarmsToDelete}),
  );

  log
    .info()
    .str('function', 'deleteUnneededLogGroupAlarms')
    .str('logGroupArn', logGroupArn)
    .num('deletedCount', alarmsToDelete.length)
    .msg('Deleted obsolete log group alarms');
}

/**
 * Lambda entry point for handling log group events delivered via SQS.
 *
 * Expected input:
 * - record.body is a JSON string containing a CloudTrail-style event for
 *   CloudWatch Logs (e.g., CreateLogGroup, DeleteLogGroup, etc.).
 *
 * Behavior:
 * - Parses eventName, logGroupName, accountId, and region from the event.
 * - Builds the log group ARN.
 * - If eventName === 'DeleteLogGroup':
 *   - Deletes all existing alarms for the log group and returns.
 * - Otherwise:
 *   - Fetches autoalarm:* tags for the log group.
 *   - If there are no autoalarm:* tags:
 *       - Deletes any existing alarms for the log group and returns.
 *   - If autoalarm:enabled === 'false':
 *       - Deletes existing alarms (AutoAlarm disabled) and returns.
 *   - Else:
 *       - Calls manageLogGroupAlarms to reconcile alarms based on tags/config.
 *
 * All operations are logged, and any errors are logged and rethrown with
 * additional context.
 *
 * @param record SQS record containing the CloudTrail event in record.body.
 */
export async function parseLogGroupEventAndCreateAlarms(
  record: SQSRecord,
): Promise<void> {
  const body = JSON.parse(record.body);
  const detail = body.detail;

  const eventName = detail?.eventName;

  let logGroupName: string | undefined =
    detail?.requestParameters?.logGroupName;

  if (!logGroupName && detail?.requestParameters?.resourceArn) {
    const resourceArn: string = detail.requestParameters.resourceArn;
    const afterLogGroup = resourceArn.split(':log-group:')[1];
    if (afterLogGroup) {
      logGroupName = afterLogGroup.replace(/:\*$/, '');
    }
  }

  if (!logGroupName) {
    log
      .error()
      .str('function', 'parseLogGroupEventAndCreateAlarms')
      .obj('body', body)
      .msg('No logGroupName found in event');
    throw new Error('No logGroupName found in event');
  }

  const accountId = body.account;
  const regionFromEvent = body.region || region;
  const logGroupArn = `arn:aws:logs:${regionFromEvent}:${accountId}:log-group:${logGroupName}:*`;

  log
    .info()
    .str('function', 'parseLogGroupEventAndCreateAlarms')
    .str('eventName', eventName)
    .str('logGroupArn', logGroupArn)
    .str('logGroupName', logGroupName)
    .msg('Processing log group event');

  // Handle DeleteLogGroup → delete alarms and bail
  if (eventName === 'DeleteLogGroup') {
    try {
      log
        .info()
        .str('function', 'parseLogGroupEventAndCreateAlarms')
        .str('logGroupArn', logGroupArn)
        .msg('Deleting alarms for deleted log group');
      await deleteExistingAlarms('Logs', logGroupArn);
      return;
    } catch (error) {
      log
        .error()
        .str('function', 'parseLogGroupEventAndCreateAlarms')
        .str('logGroupArn', logGroupArn)
        .err(error)
        .msg('Error deleting log group alarms');
      throw new Error(
        `Failed to delete alarms for log group ${logGroupName}: ${error}`,
      );
    }
  }

  // For non-delete events, fetch tags and decide whether to manage
  // alarms or delete them based on the presence and values of autoalarm:* tags.
  const tags = await fetchLogGroupTags(logGroupArn);

  // No AutoAlarm tags at all → delete any existing alarms and stop.
  if (Object.keys(tags).length === 0) {
    log
      .info()
      .str('function', 'parseLogGroupEventAndCreateAlarms')
      .str('logGroupArn', logGroupArn)
      .msg('No autoalarm tags found - deleting any existing alarms');
    await deleteExistingAlarms('Logs', logGroupArn);
    return;
  }

  // Explicitly disabled via autoalarm:enabled=false → delete alarms and stop.
  if (tags['autoalarm:enabled'] === 'false') {
    log
      .info()
      .str('function', 'parseLogGroupEventAndCreateAlarms')
      .str('logGroupArn', logGroupArn)
      .msg('autoalarm:enabled=false - deleting existing alarms');
    await deleteExistingAlarms('Logs', logGroupArn);
    return;
  }

  // AutoAlarm enabled and tags present → reconcile alarms.
  try {
    await manageLogGroupAlarms(logGroupArn, logGroupName, tags);
  } catch (error) {
    log
      .error()
      .str('function', 'parseLogGroupEventAndCreateAlarms')
      .str('logGroupArn', logGroupArn)
      .err(error)
      .msg('Error managing log group alarms');
    throw new Error(
      `Failed to manage alarms for log group ${logGroupName}: ${error}`,
    );
  }
}

const logsClient = new CloudWatchLogsClient({
  region,
  retryStrategy,
});
