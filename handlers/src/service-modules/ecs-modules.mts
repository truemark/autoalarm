import {
  ECSClient,
  ListTagsForResourceCommand,
  ListServicesCommand,
  ListServicesCommandOutput,
} from '@aws-sdk/client-ecs';
import * as logging from '@nr1e/logging';
import {AlarmClassification, Tag} from '../types/index.mjs';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {SQSRecord} from 'aws-lambda';
import {
  deleteExistingAlarms,
  buildAlarmName,
  handleAnomalyAlarms,
  handleStaticAlarms,
  getCWAlarmsForInstance,
  parseMetricAlarmOptions,
} from '../alarm-configs/utils/index.mjs';
import {ECS_CONFIGS} from '../alarm-configs/_index.mjs';
import {IBlueprintRef} from 'aws-cdk-lib/aws-bedrock';
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

export async function fetchEcsTags(ecsArn: string): Promise<Tag> {
  try {
    const command = new ListTagsForResourceCommand({
      resourceArn: ecsArn,
    });
    const response = await ecsClient.send(command);
    const tags: Tag = {};

    response.tags?.forEach((tag) => {
      if (tag.key && tag.value) {
        tags[tag.key] = tag.value;
      }
    });

    log
      .info()
      .str('function', 'fetchEcsTags')
      .str('ecsArn', ecsArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched tags for ECS Arn');
    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchEcsTags')
      .str('ecsArn', ecsArn)
      .err(error)
      .msg('Error fetching tags for ECS Arn');
    return {};
  }
}

async function checkAndManageEcsStatusAlarms(
  ecsArn: string,
  clusterName: string,
  tags: Tag,
): Promise<void> {

  const dimensions = [{Name: 'ClusterName', Value: clusterName}]; // Or ServiceName depending on resource type

  log
    .info()
    .str('function', 'checkAndManageEcsStatusAlarms')
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
    .str('function', 'checkAndManageEcsStatusAlarms')
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

export async function manageInactiveECSAlarms(ecsArn: string): Promise<void> {
  try {
    await deleteExistingAlarms('ECS', ecsArn);
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveECSAlarms')
      .err(e)
      .msg(`Error deleting ECS alarms: ${e}`);
  }
}

/**
 * Searches the provided object for the first occurrence of an ECS ARN and cluster name.
 * Serializes the object to a JSON string, looks for the substring "arn:aws:ECS",
 * and then extracts everything up to the next quotation mark.
 * Logs an error and returns an empty string if no valid ECS ARN can be found.
 *
 * @param {SQSRecord>} eventObj - A JSON-serializable object to search for an ECS ARN.
 * @returns {Record<string, string> | undefined} The extracted ECS ARN and Cluster Name, or undefined if not found.
 */
function findECSClusterInfo(
  eventObj: SQSRecord,
): {arn: string; clusterName: string} | undefined {
  const eventString = JSON.stringify(eventObj.body);

  // 1) Find where the ARN starts.
  const startIndex = eventString.indexOf('arn:aws:ecs');
  if (startIndex === -1) {
    log
      .error()
      .str('function', 'findECSClusterInfo')
      .obj('eventObj', eventObj)
      .msg('No ECS ARN found in event');
    return void 0;
  }

  // 2) Find the next quote after that.
  const endIndex = eventString.indexOf('"', startIndex);
  if (endIndex === -1) {
    log
      .error()
      .str('function', 'findECSClusterInfo')
      .obj('eventObj', eventObj)
      .msg('No ending quote found for ECS ARN');
    return void 0;
  }

  // 3) Extract the ARN
  const arn = eventString.substring(startIndex, endIndex);

  log
    .info()
    .str('function', 'findECSClusterInfo')
    .str('arn', arn)
    .str('startIndex', startIndex.toString())
    .str('endIndex', endIndex.toString())
    .msg('Extracted ECS ARN');

  // 4) Extract Cluster name from ARN and return
  return {
    arn: arn,
    clusterName: arn.split('/')[1].replace('"', '').trim(),
  };
}

/**
 * Fetches services which are needed for the cloudwatch ecs memory dimensions
 * @param cluster
 */
async function fetchEcsServices(
  cluster: string,
  nextToken?: string | undefined,
): Promise<string[] | undefined> {
  // Place holder for return token if result remain after the previous api call
  const input = {
    cluster: cluster,
    nextToken: nextToken,
  };

  // get response and then store in services string[]
  let services: string[] = [];
  const response: ListServicesCommandOutput = await ecsClient.send(
    new ListServicesCommand(input),
  );

  services.push(...response.serviceArns!);

  // Recursive loop if next token exists
  if (response.nextToken) {
    const nextServices = await fetchEcsServices(cluster, response.nextToken);
    if (nextServices) {
      services.push(...nextServices);
    }
  }

  // If no next token, return all discovered services or undefined if services is empty
  return services.every((service) => service != void 0) ? services : void 0;
}

export async function parseECSEventAndCreateAlarms(
  event: SQSRecord,
): Promise<void> {
  // Parse event body into json for later processing
  const body = JSON.parse(event.body);
  let eventType: 'Destroyed' | 'Created' | 'TagChange';

  // Step 1: Determine Event Type and Extract ECS ARN and ClusterName
  const clusterInfo = findECSClusterInfo(event);
  const ecsArn = clusterInfo?.arn;
  const clusterName = clusterInfo?.clusterName;

  if (!ecsArn || !clusterName) {
    log
      .error()
      .str('function', 'parseECSEventAndCreateAlarms')
      .obj('event', event)
      .msg('No ECS ARN or ClusterName found in event');
    throw new Error('No ECS ARN or ClusterName found in event');
  }

  log
    .info()
    .str('function', 'parseECSEventAndCreateAlarms')
    .str('ecsArn', ecsArn)
    .str('clusterName', clusterName)
    .msg('Extracted ECS ARN and ClusterName');

  // If delete cluster return early after deleting alarms
  if (body['eventName'] === 'DeleteCluster') {
    try {
      log
        .info()
        .str('function', 'parseECSEventAndCreateAlarms')
        .obj('event', event)
        .msg('DeleteCluster event detected. Deleting alarms');
      await deleteExistingAlarms('ECS', ecsArn);
      return;
    } catch (error) {
      log
        .error()
        .str('function', 'parseECSEventAndCreateAlarms')
        .obj('event', event)
        .err(error)
        .msg(`Error deleting ECS alarms`);
      throw new Error(`Error deleting ECS alarms`);
    }
  }

  // Step 2: fetch tags from event payload and parse out autoalarm tags
  const tags = await fetchEcsTags(ecsArn);

  // Check if AutoAlarm is enabled and capture all autoalarm tags from tags object
  const autoAlarmTags = Object.entries(tags).reduce(
    (acc, [key, value]) => {
      if (key.startsWith('autoalarm:')) {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, string>,
  );

  // Early return and deletion of alarms if autoalarm is disabled.
  if (
    autoAlarmTags['autoalarm:enabled'] &&
    autoAlarmTags['autoalarm:enabled'] === 'false'
  ) {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .obj('event', event)
      .msg('Autoalarm is disabled. Deleting alarms');
    await deleteExistingAlarms('ECS', ecsArn);
    return;
  }

  // throw error if no autoalarm tags found
  if (Object.keys(autoAlarmTags).length === 0) {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .obj('event', event)
      .msg('No autoalarm tags found in event. Terminating early');
    return;
  }

  // Step 3: manage alarms:
  try {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('ecsArn', ecsArn)
      .str('tags', JSON.stringify(tags))
      .obj('event', event)
      .msg('Starting to manage ECS alarms');
    await checkAndManageEcsStatusAlarms(ecsArn, clusterName, tags);
  } catch (error) {
    log
      .error()
      .str('function', 'parseECSEventAndCreateAlarms')
      .obj('event', event)
      .err(error)
      .msg(`Error managing ECS alarms}`);
    throw new Error(`Error managing ECS alarms:`);
  }
  return
}
