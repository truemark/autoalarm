import {RDSClient, DescribeDBInstancesCommand} from '@aws-sdk/client-rds';
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

const log: logging.Logger = logging.getLogger('rds-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const rdsClient: RDSClient = new RDSClient({
  region: region,
  retryStrategy: retryStrategy,
});
const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region: region,
  retryStrategy: retryStrategy,
});

const metricConfigs = MetricAlarmConfigs['RDS'];

export async function fetchRDSTags(
  dbInstanceId: string,
): Promise<{[key: string]: string}> {
  try {
    const command = new DescribeDBInstancesCommand({
      DBInstanceIdentifier: dbInstanceId,
    });
    const response = await rdsClient.send(command);

    const tags: {[key: string]: string} = {};
    response.DBInstances?.[0]?.TagList?.forEach((tag) => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .info()
      .str('function', 'fetchRDSTags')
      .str('dbInstanceId', dbInstanceId)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched database tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchRDSTags')
      .err(error)
      .str('dbInstanceId', dbInstanceId)
      .msg('Error fetching database tags');
    return {};
  }
}

async function checkAndManageRDSStatusAlarms(
  dbInstanceId: string,
  tags: Tag,
): Promise<void> {
  log
    .info()
    .str('function', 'checkAndManageRDSStatusAlarms')
    .str('dbInstanceId', dbInstanceId)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageRDSStatusAlarms')
      .str('dbInstanceId', dbInstanceId)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('dbInstanceId', dbInstanceId);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageRDSStatusAlarms')
      .obj('config', config)
      .str('dbInstanceId', dbInstanceId)
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
          .str('function', 'checkAndManageRDSStatusAlarms')
          .str('dbInstanceId', dbInstanceId)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          'RDS',
          dbInstanceId,
          [{Name: 'DBInstanceIdentifier', Value: dbInstanceId}],
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageRDSStatusAlarms')
          .str('dbInstanceId', dbInstanceId)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          'RDS',
          dbInstanceId,
          [{Name: 'DBInstanceIdentifier', Value: dbInstanceId}],
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageRDSStatusAlarms')
        .str('dbInstanceId', dbInstanceId)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            'RDS',
            dbInstanceId,
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
  const existingAlarms = await getCWAlarmsForInstance('RDS', dbInstanceId);

  // Log the full structure of retrieved alarms for debugging
  log
    .info()
    .str('function', 'checkAndManageRDSStatusAlarms')
    .obj('raw existing alarms', existingAlarms)
    .msg('Fetched existing alarms before filtering');

  // Log the expected pattern
  const expectedPattern = `AutoAlarm-RDS-${dbInstanceId}`;
  log
    .info()
    .str('function', 'checkAndManageRDSStatusAlarms')
    .str('expected alarm pattern', expectedPattern)
    .msg('Verifying alarms against expected naming pattern');

  // Check and log if alarms match expected pattern
  existingAlarms.forEach((alarm) => {
    const matchesPattern = alarm.includes(expectedPattern);
    log
      .info()
      .str('function', 'checkAndManageRDSStatusAlarms')
      .str('alarm name', alarm)
      .bool('matches expected pattern', matchesPattern)
      .msg('Evaluating alarm name match');
  });

  // Filter alarms that need deletion
  const alarmsToDelete = existingAlarms.filter(
    (alarm) => !alarmsToKeep.has(alarm),
  );

  log
    .info()
    .str('function', 'checkAndManageRDSStatusAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarms that are no longer needed');

  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageRDSStatusAlarms')
    .str('dbInstanceId', dbInstanceId)
    .msg('Finished alarm management process');
}

export async function manageInactiveRDSAlarms(
  dbInstanceId: string,
): Promise<void> {
  try {
    await deleteExistingAlarms('RDS', dbInstanceId);
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveRDSAlarms')
      .err(e)
      .msg(`Error deleting RDS alarms: ${e}`);
  }
}

// Function to extract dbInstanceId from ARN
function extractRDSInstanceIdFromArn(arn: string): string {
  const regex = /db[:/]([^:/]+)$/;
  const match = arn.match(regex);

  // log the arn and the extracted dbInstanceId
  log
    .info()
    .str('function', 'extractRDSInstanceIdFromArn')
    .str('arn', arn)
    .str('dbInstanceId', match ? match[1] : 'not found')
    .msg('Extracted dbInstanceId from ARN');

  return match ? match[1] : '';
}

/**
 * Find RDS ARN in a JSON object
 * @param {Record<string, any>} jsonObj - The JSON object to search through
 * @returns {string} The RDS ARN if found, empty string otherwise
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRDSArn(jsonObj: Record<string, any>): string {
  // If it's an object, search all values
  for (const value of Object.values(jsonObj)) {
    // If value is a string and contains RDS ARN, return it
    if (typeof value === 'string' && value.includes('arn:aws:rds')) {
      return value;
    }

    // If value is an array, search each element
    if (Array.isArray(value)) {
      for (const element of value) {
        if (typeof element! === 'string' && element.includes('arn:aws:rds')) {
          return element;
        }
      }
    }

    // If value is an object and not null, recurse
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const arn = findRDSArn(value);
      if (arn) return arn;
    }
  }

  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseRDSEventAndCreateAlarms(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any,
): Promise<{
  dbInstanceId: string;
  dbInstanceArn: string;
  eventType: string;
  tags: Record<string, string>;
} | void> {
  let dbInstanceId: string = '';
  let dbInstanceArn: string | Error = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      dbInstanceArn = findRDSArn(event);
      if (!dbInstanceArn) {
        log
          .error()
          .str('function', 'extractRDSInstanceArnFromEvent')
          .obj('event', event)
          .msg('No RDS ARN found in event for tag change event');
        throw new Error('No RDS ARN found in event');
      }
      dbInstanceId = extractRDSInstanceIdFromArn(dbInstanceArn);
      eventType = 'TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseRDSEventAndCreateAlarms')
        .str('eventType', 'TagChange')
        .str('dbInstanceId', dbInstanceId)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');

      if (dbInstanceId) {
        tags = await fetchRDSTags(dbInstanceId);
        log
          .info()
          .str('function', 'parseRDSEventAndCreateAlarms')
          .str('DB Instance ID', dbInstanceId)
          .str('tags', JSON.stringify(tags))
          .msg('Fetched tags for new TagChange event');
      } else {
        log
          .error()
          .str('function', 'parseRDSEventAndCreateAlarms')
          .str('eventType', 'TagChance')
          .msg('dbInstanceId not found in AddTagsToResource event');
        throw new Error('dbInstanceId not found in AddTagsToResource event');
      }
      break;

    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateDBInstance':
          dbInstanceArn = findRDSArn(event);
          if (!dbInstanceArn) {
            log
              .error()
              .str('function', 'extractRDSInstanceArnFromEvent')
              .obj('event', event)
              .msg('No RDS ARN found in event for tag change event');
            throw new Error(
              'No RDS ARN found in event for AWS API Call via CloudTrail event',
            );
          }
          dbInstanceId = extractRDSInstanceIdFromArn(dbInstanceArn);
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseRDSEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('dbInstanceId', dbInstanceId)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateDBInstance event');
          if (dbInstanceId) {
            tags = await fetchRDSTags(dbInstanceId);
            log
              .info()
              .str('function', 'parseRDSEventAndCreateAlarms')
              .str('dbInstanceId', dbInstanceId)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new CreateDBInstance event');
          } else {
            log
              .error()
              .str('function', 'parseRDSEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('dbInstanceId not found in CreateDBInstance event');
            throw new Error('dbInstanceId not found in CreateDBInstance event');
          }
          break;

        case 'DeleteDBInstance':
          dbInstanceId = event.detail.requestParameters?.dbInstanceIdentifier;
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseRDSEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('dbInstanceId', dbInstanceId)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteDBInstance event');
          break;

        default:
          log
            .error()
            .str('function', 'parseRDSEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
          throw new Error('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .error()
        .str('function', 'parseRDSEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
      throw new Error('Unexpected event type');
  }

  if (!dbInstanceId) {
    log
      .error()
      .str('function', 'parseRDSEventAndCreateAlarms')
      .str('dbInstanceId', dbInstanceId)
      .msg('dbInstanceId is empty');
    throw new Error('dbInstanceId is empty');
  }

  log
    .info()
    .str('function', 'parseRDSEventAndCreateAlarms')
    .str('dbInstanceId', dbInstanceId)
    .str('eventType', eventType)
    .msg('Finished processing RDS event');

  if (dbInstanceId && (eventType === 'Create' || eventType === 'TagChange')) {
    log
      .info()
      .str('function', 'parseRDSEventAndCreateAlarms')
      .str('dbInstanceId', dbInstanceId)
      .str('tags', JSON.stringify(tags))
      .str(
        'autoalarm:enabled',
        tags['autoalarm:enabled']
          ? tags['autoalarm:enabled']
          : 'autoalarm tag does not exist',
      )
      .msg('Starting to manage RDS alarms');
    await checkAndManageRDSStatusAlarms(dbInstanceId, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseRDSEventAndCreateAlarms')
      .str('dbInstanceId', dbInstanceId)
      .msg('Starting to manage inactive RDS alarms');
    await manageInactiveRDSAlarms(dbInstanceId);
  }

  return {dbInstanceArn, dbInstanceId, eventType, tags};
}
