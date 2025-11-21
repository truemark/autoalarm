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

const logsClient = new CloudWatchLogsClient({
  region,
  retryStrategy,
});

const metricConfigs = LOGGROUP_CONFIGS;

export async function fetchLogGroupTags(
  arn: string,
): Promise<Record<string, string>> {
  log
    .debug()
    .str('function', 'fetchLogGroupTags')
    .str('inputArn', arn)
    .str('resourceArn', arn)
    .msg('Calling ListTagsForResource');

  const resp = await logsClient.send(
    new ListTagsForResourceCommand({
      resourceArn: arn,
    }),
  );

  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(resp.tags ?? {})) {
    if (key.startsWith('autoalarm:')) {
      tags[key] = value ?? '';
    }
  }

  log
    .debug()
    .str('function', 'fetchLogGroupTags')
    .str('inputArn', arn)
    .obj('Filtered AutoAlarm tags', tags)
    .msg('ListTagsForResource complete');

  return tags;
}

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

async function createOrUpdateLogGroupAlarms(
  logGroupArn: string,
  logGroupName: string,
  tags: Tag,
): Promise<Set<string>> {
  log
    .debug()
    .str('function', 'createOrUpdateLogGroupAlarms')
    .str('logGroupName', logGroupName)
    .msg('Creating/updating log group alarms');

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

    log
      .info()
      .str('function', 'createOrUpdateLogGroupAlarms')
      .str('logGroupName', logGroupName)
      .bool('isAnomaly', isAnomaly)
      .msg('Determined alarm type based on tag key and configuration');

    const alarmHandler = isAnomaly ? handleAnomalyAlarms : handleStaticAlarms;

    log
      .info()
      .str('function', 'createOrUpdateLogGroupAlarms')
      .str('logGroupName', logGroupName)
      .str('metricType', config.tagKey)
      .msg('Starting alarm handler');

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
 * this interface and following function should be abstracted into their own utility class
 * along with other commonly used function[ality]/[s]
 */
interface ServiceInfo {
  arn: string;
  resourceName: string;
}

function extractLogGroupIdentifiers(
  eventBody: string,
): ServiceInfo | undefined {
  // 1) Find where the ARN starts.
  const startIndex = eventBody.indexOf('arn:aws:logs');
  if (startIndex === -1) {
    log
      .error()
      .str('function', 'extractLogGroupIdentifiers')
      .str('eventObj', eventBody)
      .msg('No LogGroup ARN found in event');
    return void 0;
  }

  // 2) Find the next quote after that.
  const endIndex = eventBody.indexOf('"', startIndex);
  if (endIndex === -1) {
    log
      .error()
      .str('function', 'extractLogGroupIdentifiers')
      .str('eventObj', eventBody)
      .msg('No ending quote found for logGrop ARN');
    return void 0;
  }

  // 3) Extract the ARN
  const arn = eventBody.substring(startIndex, endIndex).trim();

  // 4) Extract Cluster name from ARN
  const arnParts = arn.split('log-group:');
  if (arnParts.length < 2) {
    log
      .error()
      .str('function', 'findECSClusterInfo')
      .str('arn', arn)
      .msg('Invalid ECS ARN format - missing cluster name');
    return void 0;
  }

  const resourceName = arnParts[1].replace('"', '').trim();

  log
    .info()
    .str('function', 'ExtractLogGroupIdentifiers')
    .str('arn', arn)
    .str('LogGroup Name', resourceName)
    .msg('Extracted LogGroup ARN and LogGroup name');

  return {
    arn: arn,
    resourceName: resourceName,
  };
}

export async function parseLogGroupEventAndCreateAlarms(
  record: SQSRecord,
): Promise<void> {
  const body = JSON.parse(record.body);
  const detail = body.detail;
  const eventName = detail?.eventName;
  const logGroupInfo = extractLogGroupIdentifiers(record.body);
  let arn: string = '';
  let resourceName: string = '';

  // Early return and log if we're dealing with logstreams:
  if (body.detail.eventName.includes('LogStream')) {
    log
      .info()
      .str('function', 'parseLogGroupEventAndCreateAlarms')
      .str('eventName', eventName)
      .msg(
        'Log stream event. No Alarm management necessary, please tag LogGroup instead of LogStream for autoalarm management',
      );
    return;
  }

  if (logGroupInfo) {
    arn = logGroupInfo.arn;
    resourceName = logGroupInfo.resourceName;
  }

  if (!logGroupInfo) {
    log
      .error()
      .str('function', 'parseLogGroupEventAndCreateAlarms')
      .str('eventName', eventName)
      .msg(
        'Failed to extract log group identifiers. Trying manual json mapping',
      );

    try {
      resourceName = body.detail.requestParameters.logGroupName;
      arn = `arn:aws:logs:${body.region}:${body.account}:log-group:${resourceName}`;
      log
        .info()
        .str('function', 'parseLogGroupEventAndCreateAlarms')
        .str('eventName', eventName)
        .str('logGroupArn', arn)
        .str('logGroupName', resourceName)
        .msg('Extracted LogGroup ARN and LogGroup name');
    } catch {
      log
        .error()
        .str('function', 'parseLogGroupEventAndCreateAlarms')
        .str('eventName', eventName)
        .msg('Failed to extract log group identifiers');
      throw new Error('Failed to extract log group identifiers', {
        cause: record,
      });
    }
  }

  log
    .info()
    .str('function', 'parseLogGroupEventAndCreateAlarms')
    .str('eventName', eventName)
    .str('logGroupArn', arn)
    .str('logGroupName', resourceName)
    .msg('Processing log group event');

  // Early alarm deletion if delete event
  if (eventName === 'DeleteLogGroup') {
    log
      .info()
      .str('function', 'parseLogGroupEventAndCreateAlarms')
      .str('eventName', eventName)
      .msg('Processing delete log group event');

    const allAlarms = await getCWAlarmsForInstance('Logs', arn);
    await cloudWatchClient.send(
      new DeleteAlarmsCommand({AlarmNames: allAlarms}),
    );
    return;
  }

  // For non-delete events, fetch tags and filter out AutoAlarm Tags
  const tags = await fetchLogGroupTags(arn);

  // No AutoAlarm tags at all → delete any existing alarms and stop.
  if (Object.keys(tags).length === 0) {
    log
      .info()
      .str('function', 'parseLogGroupEventAndCreateAlarms')
      .str('logGroupArn', arn)
      .msg('No autoalarm tags found - deleting any existing alarms');
    await deleteExistingAlarms('LOGS', arn);
    return;
  }

  // Explicitly disabled via autoalarm:enabled=false → delete alarms and stop.
  if (tags['autoalarm:enabled'] === 'false') {
    log
      .info()
      .str('function', 'parseLogGroupEventAndCreateAlarms')
      .str('logGroupArn', arn)
      .msg('autoalarm:enabled=false - deleting existing alarms');
    await deleteExistingAlarms('Logs', arn);
    return;
  }

  // AutoAlarm enabled and tags present → reconcile alarms.
  try {
    await manageLogGroupAlarms(arn, resourceName, tags);
  } catch (error) {
    log
      .error()
      .str('function', 'parseLogGroupEventAndCreateAlarms')
      .str('logGroupArn', arn)
      .err(error)
      .msg('Error managing log group alarms');
    throw new Error(
      `Failed to manage alarms for log group ${resourceName}: ${error}`,
    );
  }
}
