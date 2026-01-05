import {
  DynamoDBClient,
  ListTagsOfResourceCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import {
  LambdaClient,
  ListEventSourceMappingsCommand,
} from '@aws-sdk/client-lambda';
import * as logging from '@nr1e/logging';
import {Tag} from '../types/index.mjs';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {SQSRecord} from 'aws-lambda';
import {
  deleteExistingAlarms,
  handleAnomalyAlarms,
  handleStaticAlarms,
  getCWAlarmsForInstance,
  parseMetricAlarmOptions,
} from '../alarm-configs/utils/index.mjs';
import {DYNAMODB_CONFIGS} from '../alarm-configs/_index.mjs';
import {Dimension} from '../types/module-types.mjs';

const log: logging.Logger = logging.getLogger('dynamodb-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);

const dynamoDBClient = new DynamoDBClient({
  region,
  retryStrategy,
});

const lambdaClient = new LambdaClient({
  region,
  retryStrategy,
});

const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region,
  retryStrategy,
});

const metricConfigs = DYNAMODB_CONFIGS;

interface DynamoDBTableInfo {
  tableArn: string;
  tableName: string;
}

function extractDynamoDBTableInfo(
  eventBody: string,
  accountId: string,
): DynamoDBTableInfo | undefined {
  const searchIndex = 0;
  const region: string = process.env.AWS_REGION!;
  const arnPrefix = `arn:aws:dynamodb:${region}:${accountId}:table`;

  const startIndex = eventBody.indexOf(arnPrefix, searchIndex);
  if (startIndex === -1) {
    log
      .error()
      .str('function', 'extractDynamoDBTableInfo')
      .msg('No DynamoDB table ARN found in event');
    return void 0;
  }

  const endIndex = eventBody.indexOf('"', startIndex);
  if (endIndex === -1) {
    log
      .error()
      .str('function', 'extractDynamoDBTableInfo')
      .msg('No ending quote found for DynamoDB ARN');
    return void 0;
  }

  const arn = eventBody.substring(startIndex, endIndex).trim();
  const arnParts = arn.split('/');

  if (arnParts.length < 2) {
    log
      .error()
      .str('function', 'extractDynamoDBTableInfo')
      .str('arn', arn)
      .msg('Invalid DynamoDB table ARN format - missing table name');
    return void 0;
  }

  // arn:aws:dynamodb:region:account:table/TableName[/...]
  const tableName = arnParts[1].trim();

  log
    .info()
    .str('function', 'extractDynamoDBTableInfo')
    .str('tableArn', arn)
    .str('tableName', tableName)
    .msg('Extracted DynamoDB table info');

  return {
    tableArn: arn,
    tableName,
  };
}

export async function fetchDynamoDBTags(tableArn: string): Promise<Tag> {
  try {
    const command = new ListTagsOfResourceCommand({ResourceArn: tableArn});
    const response = await dynamoDBClient.send(command);

    const tags: Tag = {};
    response.Tags?.forEach((tag) => {
      if (tag.Key && tag.Value && tag.Key.startsWith('autoalarm:')) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .debug()
      .str('function', 'fetchDynamoDBTags')
      .str('tableArn', tableArn)
      .num('tagCount', Object.keys(tags).length)
      .msg('Fetched DynamoDB tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchDynamoDBTags')
      .str('tableArn', tableArn)
      .err(error)
      .msg('Error fetching DynamoDB tags');
    return {};
  }
}

/**
 * Get the DynamoDB Stream ARN for a table if streams are enabled.
 * Returns undefined if streams are not enabled.
 */
async function getTableStreamArn(
  tableName: string,
): Promise<string | undefined> {
  try {
    const command = new DescribeTableCommand({TableName: tableName});
    const response = await dynamoDBClient.send(command);

    const streamArn = response.Table?.LatestStreamArn;

    if (streamArn) {
      log
        .info()
        .str('function', 'getTableStreamArn')
        .str('tableName', tableName)
        .str('streamArn', streamArn)
        .msg('Found DynamoDB Stream ARN');
    } else {
      log
        .info()
        .str('function', 'getTableStreamArn')
        .str('tableName', tableName)
        .msg('Table does not have streams enabled');
    }

    return streamArn;
  } catch (error) {
    log
      .error()
      .str('function', 'getTableStreamArn')
      .str('tableName', tableName)
      .err(error)
      .msg('Error fetching table stream ARN');
    return undefined;
  }
}

/**
 * Get all Lambda event source mappings (consumers) for a DynamoDB Stream.
 * Only returns enabled mappings.
 */
async function getStreamConsumers(
  streamArn: string,
): Promise<Array<{functionArn: string; functionName: string; uuid: string}>> {
  try {
    const command = new ListEventSourceMappingsCommand({
      EventSourceArn: streamArn,
    });
    const response = await lambdaClient.send(command);

    const consumers =
      response.EventSourceMappings?.filter(
        (mapping) =>
          mapping.State === 'Enabled' || mapping.State === 'Enabling',
      ).map((mapping) => {
        // Extract function name from ARN: arn:aws:lambda:region:account:function:FunctionName
        const functionName = mapping.FunctionArn?.split(':').pop() || '';
        return {
          functionArn: mapping.FunctionArn || '',
          functionName,
          uuid: mapping.UUID || '',
        };
      }) || [];

    log
      .info()
      .str('function', 'getStreamConsumers')
      .str('streamArn', streamArn)
      .num('consumerCount', consumers.length)
      .msg('Found Lambda consumers for DynamoDB Stream');

    return consumers;
  } catch (error) {
    log
      .error()
      .str('function', 'getStreamConsumers')
      .str('streamArn', streamArn)
      .err(error)
      .msg('Error fetching stream consumers');
    return [];
  }
}

/**
 * Manage IteratorAge alarms for DynamoDB Stream consumers (Lambda functions).
 * Creates alarms for each enabled Lambda consumer of the stream.
 */
async function manageIteratorAgeAlarms(
  tableArn: string,
  tableName: string,
  tags: Tag,
): Promise<Set<string>> {
  const alarmsToKeep = new Set<string>();

  // Check if iterator-age monitoring is enabled
  const iteratorAgeConfig = metricConfigs.find(
    (config) => config.tagKey === 'iterator-age',
  );

  if (!iteratorAgeConfig) {
    return alarmsToKeep;
  }

  const tagValue = tags['autoalarm:iterator-age'];
  if (tagValue === undefined) {
    log
      .info()
      .str('function', 'manageIteratorAgeAlarms')
      .str('tableArn', tableArn)
      .msg('iterator-age tag not present - skipping IteratorAge alarms');
    return alarmsToKeep;
  }

  // Get stream ARN
  const streamArn = await getTableStreamArn(tableName);
  if (!streamArn) {
    log
      .info()
      .str('function', 'manageIteratorAgeAlarms')
      .str('tableName', tableName)
      .msg('Table does not have streams enabled - skipping IteratorAge alarms');
    return alarmsToKeep;
  }

  // Get consumers
  const consumers = await getStreamConsumers(streamArn);
  if (consumers.length === 0) {
    log
      .info()
      .str('function', 'manageIteratorAgeAlarms')
      .str('streamArn', streamArn)
      .msg('No enabled Lambda consumers found - skipping IteratorAge alarms');
    return alarmsToKeep;
  }

  // Parse alarm options
  const updatedDefaults = parseMetricAlarmOptions(
    tagValue,
    iteratorAgeConfig.defaults,
  );

  // Create alarm for each consumer
  for (const consumer of consumers) {
    const dimensions: Dimension[] = [
      {Name: 'FunctionName', Value: consumer.functionName},
    ];

    // Use table ARN + function name as identifier for alarm naming
    const alarmIdentifier = `${tableArn}-${consumer.functionName}`;

    log
      .info()
      .str('function', 'manageIteratorAgeAlarms')
      .str('functionName', consumer.functionName)
      .str('tableArn', tableArn)
      .msg('Creating IteratorAge alarm for Lambda consumer');

    const alarmNames = await handleStaticAlarms(
      iteratorAgeConfig,
      'DynamoDB',
      alarmIdentifier,
      dimensions,
      updatedDefaults,
    );

    alarmNames.forEach((name) => alarmsToKeep.add(name));
  }

  log
    .info()
    .str('function', 'manageIteratorAgeAlarms')
    .num('consumerCount', consumers.length)
    .num('alarmsCreated', alarmsToKeep.size)
    .msg('Completed IteratorAge alarm management');

  return alarmsToKeep;
}

async function manageDynamoDBAlarms(
  tableArn: string,
  tableName: string,
  tags: Tag,
): Promise<void> {
  const dimensions: Dimension[] = [{Name: 'TableName', Value: tableName}];

  log
    .info()
    .str('function', 'manageDynamoDBAlarms')
    .str('tableArn', tableArn)
    .msg('Managing DynamoDB table alarms');

  const alarmsToKeep = await createOrUpdateAlarms(
    tableArn,
    tags,
    'DynamoDB',
    dimensions,
  );

  await deleteUnneededAlarms(tableArn, alarmsToKeep, 'DynamoDB');

  log
    .info()
    .str('function', 'manageDynamoDBAlarms')
    .num('alarmsManaged', alarmsToKeep.size)
    .msg('DynamoDB table alarm management complete');
}

async function createOrUpdateAlarms(
  resourceArn: string,
  tags: Tag,
  serviceType: string,
  dimensions: Dimension[],
): Promise<Set<string>> {
  const alarmsToKeep = new Set<string>();
  for (const config of metricConfigs) {
    const tagValue = tags[`autoalarm:${config.tagKey}`];

    if (!config.defaultCreate && tagValue === undefined) {
      continue;
    }

    const updatedDefaults = parseMetricAlarmOptions(
      tagValue || '',
      config.defaults,
    );

    const alarmHandler = config.tagKey.includes('anomaly')
      ? handleAnomalyAlarms
      : handleStaticAlarms;

    const alarmNames = await alarmHandler(
      config,
      serviceType,
      resourceArn,
      dimensions,
      updatedDefaults,
    );

    alarmNames.forEach((name) => alarmsToKeep.add(name));

    log
      .debug()
      .str('metricType', config.tagKey)
      .num('alarmsCreated', alarmNames.length)
      .msg('Processed DynamoDB metric configuration');
  }

  return alarmsToKeep;
}

async function deleteUnneededAlarms(
  resourceArn: string,
  alarmsToKeep: Set<string>,
  serviceType: string,
): Promise<void> {
  const existingAlarms = await getCWAlarmsForInstance(serviceType, resourceArn);
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
    .num('deletedCount', alarmsToDelete.length)
    .msg('Deleted obsolete DynamoDB table alarms');
}

/**
 * Entry point to module to manage DynamoDB table alarms.
 */
export async function parseDynamoDBEventAndCreateAlarms(
  record: SQSRecord,
  accountId: string,
): Promise<void> {
  const body = JSON.parse(record.body);
  const eventName = body.detail?.eventName;

  const tableInfo = extractDynamoDBTableInfo(record.body, accountId);

  if (!tableInfo) {
    log
      .error()
      .str('function', 'parseDynamoDBEventAndCreateAlarms')
      .msg('Failed to extract DynamoDB table info from event');
    throw new Error('No valid DynamoDB table info found in event');
  }

  const {tableArn, tableName} = tableInfo;

  log
    .info()
    .str('function', 'parseDynamoDBEventAndCreateAlarms')
    .str('eventName', eventName)
    .str('tableArn', tableArn)
    .str('tableName', tableName)
    .msg('Processing DynamoDB table event');

  if (eventName === 'DeleteTable') {
    try {
      log
        .info()
        .str('function', 'parseDynamoDBEventAndCreateAlarms')
        .str('tableArn', tableArn)
        .msg('Deleting alarms for deleted DynamoDB table');
      await deleteExistingAlarms('DynamoDB', tableArn);
      return;
    } catch (error) {
      log
        .error()
        .str('function', 'parseDynamoDBEventAndCreateAlarms')
        .str('tableArn', tableArn)
        .err(error)
        .msg('Error deleting DynamoDB alarms for deleted table');
      throw new Error(
        `Failed to delete alarms for table ${tableName}: ${error}`,
      );
    }
  }

  const tags = await fetchDynamoDBTags(tableArn);

  if (Object.keys(tags).length === 0) {
    log
      .info()
      .str('function', 'parseDynamoDBEventAndCreateAlarms')
      .str('tableArn', tableArn)
      .msg('No autoalarm tags found - skipping alarm management');
    await deleteExistingAlarms('DynamoDB', tableArn);
    return;
  }

  if (tags['autoalarm:enabled'] === 'false') {
    log
      .info()
      .str('function', 'parseDynamoDBEventAndCreateAlarms')
      .str('tableArn', tableArn)
      .msg('AutoAlarm disabled - deleting existing alarms');
    await deleteExistingAlarms('DynamoDB', tableArn);
    return;
  }

  if (!tags['autoalarm:enabled']) {
    log
      .info()
      .str('function', 'parseDynamoDBEventAndCreateAlarms')
      .str('tableArn', tableArn)
      .msg(
        'autoalarm:enabled tag not found - skipping alarm management and deleting existing alarms',
      );
    await deleteExistingAlarms('DynamoDB', tableArn);
    return;
  }

  try {
    log
      .info()
      .str('function', 'parseDynamoDBEventAndCreateAlarms')
      .str('tableArn', tableArn)
      .num('autoAlarmTagCount', Object.keys(tags).length)
      .msg('Managing DynamoDB table alarms');
    await manageDynamoDBAlarms(tableArn, tableName, tags);

    // Manage IteratorAge alarms for stream consumers
    const iteratorAgeAlarms = await manageIteratorAgeAlarms(
      tableArn,
      tableName,
      tags,
    );

    if (iteratorAgeAlarms.size > 0) {
      log
        .info()
        .str('function', 'parseDynamoDBEventAndCreateAlarms')
        .num('iteratorAgeAlarms', iteratorAgeAlarms.size)
        .msg('Created IteratorAge alarms for stream consumers');
    }
  } catch (error) {
    log
      .error()
      .str('function', 'parseDynamoDBEventAndCreateAlarms')
      .str('tableArn', tableArn)
      .err(error)
      .msg('Error managing DynamoDB table alarms');
    throw new Error(`Failed to manage alarms for table ${tableName}: ${error}`);
  }
}
