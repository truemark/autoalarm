import {RDSClient, DescribeDBClustersCommand} from '@aws-sdk/client-rds';
import * as logging from '@nr1e/logging';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {AlarmClassification, Tag} from '../types/index.mjs';
import {
  getCWAlarmsForInstance,
  deleteExistingAlarms,
  buildAlarmName,
  handleAnomalyAlarms,
  handleStaticAlarms,
  parseMetricAlarmOptions,
} from '../alarm-configs/utils/index.mjs';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {RDS_CLUSTER_CONFIGS} from '../alarm-configs/index.mjs';

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

const metricConfigs = RDS_CLUSTER_CONFIGS;

export async function fetchRDSClusterTags(
  dbClusterId: string,
): Promise<{[key: string]: string}> {
  try {
    const command = new DescribeDBClustersCommand({
      DBClusterIdentifier: dbClusterId,
    });
    const response = await rdsClient.send(command);

    const tags: {[key: string]: string} = {};
    response.DBClusters?.[0]?.TagList?.forEach((tag) => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .info()
      .str('function', 'fetchRDSClusterTags')
      .str('dbClusterId', dbClusterId)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched database cluster tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchRDSClusterTags')
      .err(error)
      .str('dbClusterId', dbClusterId)
      .msg('Error fetching database cluster tags');
    return {};
  }
}

async function checkAndManageRDSClusterStatusAlarms(
  dbClusterId: string,
  tags: Tag,
): Promise<void> {
  log
    .info()
    .str('function', 'checkAndManageRDSClusterStatusAlarms')
    .str('dbClusterId', dbClusterId)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageRDSClusterStatusAlarms')
      .str('dbClusterId', dbClusterId)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('RDSCluster', dbClusterId);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageRDSClusterStatusAlarms')
      .obj('config', config)
      .str('dbClusterId', dbClusterId)
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
          .str('function', 'checkAndManageRDSClusterStatusAlarms')
          .str('dbClusterId', dbClusterId)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          'RDSCluster',
          dbClusterId,
          [{Name: 'DBClusterIdentifier', Value: dbClusterId}],
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageRDSClusterStatusAlarms')
          .str('dbClusterId', dbClusterId)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          'RDSCluster',
          dbClusterId,
          [{Name: 'DBClusterIdentifier', Value: dbClusterId}],
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageRDSClusterStatusAlarms')
        .str('dbClusterId', dbClusterId)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            'RDSCluster',
            dbClusterId,
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
  const existingAlarms = await getCWAlarmsForInstance('RDS', dbClusterId);

  // Log the full structure of retrieved alarms for debugging
  log
    .info()
    .str('function', 'checkAndManageRDSClusterStatusAlarms')
    .obj('raw existing alarms', existingAlarms)
    .msg('Fetched existing alarms before filtering');

  // Log the expected pattern
  const expectedPattern = `AutoAlarm-RDSCluster-${dbClusterId}`;
  log
    .info()
    .str('function', 'checkAndManageRDSClusterStatusAlarms')
    .str('expected alarm pattern', expectedPattern)
    .msg('Verifying alarms against expected naming pattern');

  // Check and log if alarms match expected pattern
  existingAlarms.forEach((alarm) => {
    const matchesPattern = alarm.includes(expectedPattern);
    log
      .info()
      .str('function', 'checkAndManageRDSClusterStatusAlarms')
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
    .str('function', 'checkAndManageRDSClusterStatusAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarms that are no longer needed');

  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageRDSClusterStatusAlarms')
    .str('dbClusterId', dbClusterId)
    .msg('Finished alarm management process');
}

export async function manageInactiveRDSClusterAlarms(
  dbClusterId: string,
): Promise<void> {
  try {
    await deleteExistingAlarms('RDSCluster', dbClusterId);
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveRDSClusterAlarms')
      .err(e)
      .msg(`Error deleting RDS alarms: ${e}`);
  }
}

// Function to extract dbClusterId from ARN
function extractRDSClusterIdFromArn(arn: string): string {
  const regex = /cluster[:/]([^:/]+)$/;
  const match = arn.match(regex);

  // log the arn and the extracted dbClusterId
  log
    .info()
    .str('function', 'extractRDSClusterIdFromArn')
    .str('arn', arn)
    .str('dbClusterId', match ? match[1] : 'not found')
    .msg('Extracted dbClusterId from ARN');

  return match ? match[1] : '';
}

/**
 * Searches the provided object for the first occurrence of an RDS ARN.
 * Serializes the object to a JSON string, looks for the substring "arn:aws:rds",
 * and then extracts everything up to the next quotation mark.
 * Logs an error and returns an empty string if no valid RDS ARN can be found.
 *
 * @param {Record<string, any>} eventObj - A JSON-serializable object to search for an RDS ARN.
 * @returns {string} The extracted RDS ARN, or an empty string if not found.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRDSClusterArn(eventObj: Record<string, any>): string {
  const eventString = JSON.stringify(eventObj);

  // 1) Find where the ARN starts.
  const startIndex = eventString.indexOf('arn:aws:rds');
  if (startIndex === -1) {
    log
      .error()
      .str('function', 'findRDSArn')
      .obj('eventObj', eventObj)
      .msg('No RDS ARN found in event');
    return '';
  }

  // 2) Find the next quote after that.
  const endIndex = eventString.indexOf('"', startIndex);
  if (endIndex === -1) {
    log
      .error()
      .str('function', 'findRDSArn')
      .obj('eventObj', eventObj)
      .msg('No ending quote found for RDS ARN');
    return '';
  }

  // 3) Extract the ARN
  const arn = eventString.substring(startIndex, endIndex);

  log
    .info()
    .str('function', 'findRDSArn')
    .str('arn', arn)
    .str('startIndex', startIndex.toString())
    .str('endIndex', endIndex.toString())
    .msg('Extracted RDS ARN');

  return arn;
}


// On occasion AWS will splice the arn with the resource ID. If this happens, we need to remap the arn from the resource ID.
function getARNFromResourceId(arn: string): string {
  if (!arn.includes('cluster:cluster-')) return arn;

  log
    .warn()
    .str('function', 'getARNFromResourceId')
    .str('Received ARN', arn)
    .msg(
      'ARN is malformed and uses resource ID. Attempting to map ARN from resource ID',
    );

  const command = new DescribeDBClustersCommand({
    Filters: [
      {
        Name: arn.split(':').at(-1), // grab the last index which is the resource ID
        Values: ['db-cluster-resource-id'],
      },
    ],
  });

  try {
    const response = await rdsClient.send(command);

    // Check if any clusters were found
    if (response.DBClusters && response.DBClusters.length > 0) {
      // Return the ARN from the first matching cluster
      return response.DBClusters[0].DBClusterArn!;
    } else {
      log
        .info()
        .str('function', 'getARNFromResourceId')
        .str('resourceId', arn)
        .str('resourceID', arn.split(':').at(-1))
        .msg('No DB cluster found with the provided resource ID');
      throw new Error(`No DB cluster found with resource ID: ${resourceId}`);
    }
  } catch (error) {
    console.error('Error retrieving DB cluster ARN:', error);
    throw error;
  }
}

export async function parseRDSClusterEventAndCreateAlarms(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: Record<string, any>,
): Promise<{
  dbClusterId: string;
  dbClusterArn: string;
  eventType: string;
  tags: Record<string, string>;
} | void> {
  let dbClusterId: string = '';
  let dbClusterArn: string | Error = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      dbClusterArn = findRDSClusterArn(event);
      if (!dbClusterArn) {
        log
          .error()
          .str('function', 'parseRDSClusterEventAndCreateAlarms')
          .obj('event', event)
          .msg('No RDS Cluster ARN found in event for tag change event');
        throw new Error('No RDS Cluster ARN found in event');
      }
      dbClusterId = extractRDSClusterIdFromArn(dbClusterArn);
      eventType = 'TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseRDSClusterEventAndCreateAlarms')
        .str('eventType', 'TagChange')
        .str('dbClusterId', dbClusterId)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');

      if (dbClusterId) {
        tags = await fetchRDSClusterTags(dbClusterId);
        log
          .info()
          .str('function', 'parseRDSClusterEventAndCreateAlarms')
          .str('DB Cluster ID', dbClusterId)
          .str('tags', JSON.stringify(tags))
          .msg('Fetched tags for new TagChange event');
      } else {
        log
          .error()
          .str('function', 'parseRDSClusterEventAndCreateAlarms')
          .str('eventType', 'TagChance')
          .msg('dbClusterId not found in AddTagsToResource event');
        throw new Error('dbClusterId not found in AddTagsToResource event');
      }
      break;

    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateDBCluster':
          dbClusterArn = findRDSClusterArn(event);
          if (!dbClusterArn) {
            log
              .error()
              .str('function', 'parseRDSClusterEventAndCreateAlarms')
              .obj('event', event)
              .msg('No RDS Cluster ARN found in event for tag change event');
            throw new Error(
              'No RDS Cluster ARN found in event for AWS API Call via CloudTrail event',
            );
          }
          dbClusterId = extractRDSClusterIdFromArn(dbClusterArn);
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseRDSClusterEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('dbClusterId', dbClusterId)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateDBCluster event');
          if (dbClusterId) {
            tags = await fetchRDSClusterTags(dbClusterId);
            log
              .info()
              .str('function', 'parseRDSClusterEventAndCreateAlarms')
              .str('dbClusterId', dbClusterId)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new CreateDBCluster event');
          } else {
            log
              .error()
              .str('function', 'parseRDSClusterEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('dbClusterId not found in CreateDBCluster event');
            throw new Error('dbClusterId not found in CreateDBCluster event');
          }
          break;

        case 'DeleteDBCluster':
          dbClusterArn = findRDSClusterArn(event);
          if (!dbClusterArn) {
            log
              .error()
              .str('function', 'parseRDSClusterEventAndCreateAlarms')
              .obj('event', event)
              .msg('No RDS Cluster ARN found in event DeleteDBCluster event');
            throw new Error(
              'No RDS Cluster ARN found in event for AWS API Call via CloudTrail event',
            );
          }
          dbClusterId = extractRDSClusterIdFromArn(dbClusterArn);
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseRDSClusterEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('dbClusterId', dbClusterId)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteDBCluster event');
          break;

        default:
          log
            .error()
            .str('function', 'parseRDSClusterEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
          throw new Error('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .error()
        .str('function', 'parseRDSClusterEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
      throw new Error('Unexpected event type');
  }

  if (!dbClusterId) {
    log
      .error()
      .str('function', 'parseRDSClusterEventAndCreateAlarms')
      .str('dbClusterId', dbClusterId)
      .msg('dbClusterId is empty');
    throw new Error('dbClusterId is empty');
  }

  log
    .info()
    .str('function', 'parseRDSClusterEventAndCreateAlarms')
    .str('dbClusterId', dbClusterId)
    .str('eventType', eventType)
    .msg('Finished processing RDS Cluster event');

  if (dbClusterId && (eventType === 'Create' || eventType === 'TagChange')) {
    log
      .info()
      .str('function', 'parseRDSClusterEventAndCreateAlarms')
      .str('dbClusterId', dbClusterId)
      .str('tags', JSON.stringify(tags))
      .str(
        'autoalarm:enabled',
        tags['autoalarm:enabled']
          ? tags['autoalarm:enabled']
          : 'autoalarm tag does not exist',
      )
      .msg('Starting to manage RDS Cluster alarms');
    await checkAndManageRDSClusterStatusAlarms(dbClusterId, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseRDSClusterEventAndCreateAlarms')
      .str('dbClusterId', dbClusterId)
      .msg('Starting to manage inactive RDS Cluster alarms');
    await manageInactiveRDSClusterAlarms(dbClusterId);
  }

  return {dbClusterArn, dbClusterId, eventType, tags};
}
