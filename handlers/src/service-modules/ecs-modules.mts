import {ECSClient, ListTagsForResourceCommand} from '@aws-sdk/client-ecs';
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
import {ECS_CONFIGS} from '../alarm-configs/_index.mjs';
import {Dimension} from '../types/module-types.mjs';

const log: logging.Logger = logging.getLogger('ecs-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const ecsClient = new ECSClient({
  region: region,
  retryStrategy: retryStrategy,
});

const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region: region,
  retryStrategy: retryStrategy,
});

const metricConfigs = ECS_CONFIGS;

interface ECSClusterInfo {
  arn: string;
  clusterName: string;
}

function extractECSClusterInfo(eventBody: string): ECSClusterInfo | undefined {
  // 1) Find where the ARN starts.
  const startIndex = eventBody.indexOf('arn:aws:ecs');
  if (startIndex === -1) {
    log
      .error()
      .str('function', 'findECSClusterInfo')
      .str('eventObj', eventBody)
      .msg('No ECS ARN found in event');
    return void 0;
  }

  // 2) Find the next quote after that.
  const endIndex = eventBody.indexOf('"', startIndex);
  if (endIndex === -1) {
    log
      .error()
      .str('function', 'findECSClusterInfo')
      .str('eventObj', eventBody)
      .msg('No ending quote found for ECS ARN');
    return void 0;
  }

  // 3) Extract the ARN
  const arn = eventBody.substring(startIndex, endIndex).trim();

  // TODO: start here to build the array, grab the len of the arn and then split by '/' and if the length matches the service pattern length
  //  then we can determine if its a cluster or a service and then extract the name accordingly.
  //  you'll need to change the return object and then backport that into parseECSEventAndCreateAlarms
  // 4) Extract Cluster name from ARN
  const arnParts = arn.split('/');
  if (arnParts.length < 2) {
    log
      .error()
      .str('function', 'findECSClusterInfo')
      .str('arn', arn)
      .msg('Invalid ECS ARN format - missing cluster name');
    return void 0;
  }

  const clusterName = arnParts[1].replace('"', '').trim();

  log
    .info()
    .str('function', 'findECSClusterInfo')
    .str('arn', arn)
    .str('clusterName', clusterName)
    .msg('Extracted ECS ARN and cluster name');

  return {
    arn: arn,
    clusterName: clusterName,
  };
}

export async function fetchEcsTags(ecsArn: string): Promise<Tag> {
  try {
    const command = new ListTagsForResourceCommand({resourceArn: ecsArn});
    const response = await ecsClient.send(command);

    const tags: Tag = {};
    response.tags?.forEach((tag) => {
      if (tag.key && tag.value && tag.key.startsWith('autoalarm:')) {
        tags[tag.key] = tag.value;
      }
    });

    log
      .debug()
      .str('function', 'fetchEcsTags')
      .str('ecsArn', ecsArn)
      .num('tagCount', Object.keys(tags).length)
      .msg('Fetched ECS tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchEcsTags')
      .str('ecsArn', ecsArn)
      .err(error)
      .msg('Error fetching ECS tags');
    return {};
  }
}

async function manageEcsAlarms(
  ecsArn: string,
  clusterName: string,
  tags: Tag,
): Promise<void> {
  const dimensions = [{Name: 'ClusterName', Value: clusterName}]; // Or ServiceName depending on resource type

  log
    .info()
    .str('function', 'manageEcsAlarms')
    .str('ecsArn', ecsArn)
    .msg('Managing ECS alarms');

  const alarmsToKeep = await createOrUpdateAlarms(
    ecsArn,
    tags,
    'ECS',
    dimensions,
  );

  await deleteUnneededAlarms(ecsArn, alarmsToKeep, 'ECS');

  log
    .info()
    .str('function', 'manageEcsAlarms')
    .num('alarmsManaged', alarmsToKeep.size)
    .msg('Alarm management complete');
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
      .msg('Processed metric configuration');
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
    .msg('Deleted obsolete alarms');
}

/**
 * entry point to module to manage ecs alarms
 */
export async function parseECSEventAndCreateAlarms(
  record: SQSRecord,
): Promise<void> {
  const body = JSON.parse(record.body);

  // Step 1: Extract cluster info
  const clusterInfo = extractECSClusterInfo(record.body);

  if (!clusterInfo) {
    log
      .error()
      .str('function', 'parseECSEventAndCreateAlarms')
      .msg('Failed to extract ECS cluster info from event');
    throw new Error('No valid ECS cluster info found in event');
  }

  const {arn: ecsArn, clusterName} = clusterInfo;

  log
    .info()
    .str('function', 'parseECSEventAndCreateAlarms')
    .str('eventName', body.eventName)
    .str('ecsArn', ecsArn)
    .str('clusterName', clusterName)
    .msg('Processing ECS event');

  // Step 2: Handle cluster deletion
  if (body.eventName === 'DeleteCluster') {
    try {
      log
        .info()
        .str('function', 'parseECSEventAndCreateAlarms')
        .str('ecsArn', ecsArn)
        .msg('Deleting alarms for deleted cluster');
      await deleteExistingAlarms('ECS', ecsArn);
      return;
    } catch (error) {
      log
        .error()
        .str('function', 'parseECSEventAndCreateAlarms')
        .str('ecsArn', ecsArn)
        .err(error)
        .msg('Error deleting ECS alarms for deleted cluster');
      throw new Error(
        `Failed to delete alarms for cluster ${clusterName}: ${error}`,
      );
    }
  }

  // Step 3: Fetch and filter tags
  const tags = await fetchEcsTags(ecsArn);
  const autoAlarmTags = await fetchEcsTags(ecsArn);

  if (Object.keys(tags).length === 0) {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('ecsArn', ecsArn)
      .msg('No autoalarm tags found - skipping alarm management');
    await deleteExistingAlarms('ECS', ecsArn);
    return;
  }

  // Check if AutoAlarm is explicitly disabled
  if (autoAlarmTags['autoalarm:enabled'] === 'false') {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('ecsArn', ecsArn)
      .msg('AutoAlarm disabled - deleting existing alarms');
    await deleteExistingAlarms('ECS', ecsArn);
    return;
  }

  // Step 4: Manage alarms
  try {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('ecsArn', ecsArn)
      .num('autoAlarmTagCount', Object.keys(autoAlarmTags).length)
      .msg('Managing ECS cluster alarms');
    await manageEcsAlarms(ecsArn, clusterName, tags);
  } catch (error) {
    log
      .error()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('ecsArn', ecsArn)
      .err(error)
      .msg('Error managing ECS alarms');
    throw new Error(
      `Failed to manage alarms for cluster ${clusterName}: ${error}`,
    );
  }
}
