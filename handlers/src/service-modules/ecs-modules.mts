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
  region,
  retryStrategy,
});

const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region,
  retryStrategy,
});

const metricConfigs = ECS_CONFIGS;

interface ECSTaskInfo {
  arn: string;
  clusterName: string;
  taskId: string;
}

/**
 * Extract ECS task information from the raw event body.
 *
 * We scan for ECS ARNs and return the first one that matches the
 * ECS task ARN pattern:
 *   arn:aws:ecs:region:account:task/clusterName/taskId
 */
function extractECSTaskInfo(eventBody: string): ECSTaskInfo | undefined {
  let searchIndex = 0;
  let sawAnyEcsArn = false;

  while (true) {
    const startIndex = eventBody.indexOf('arn:aws:ecs', searchIndex);
    if (startIndex === -1) {
      if (!sawAnyEcsArn) {
        log
          .error()
          .str('function', 'extractECSTaskInfo')
          .str('eventObj', eventBody)
          .msg('No ECS ARN found in event');
      } else {
        log
          .info()
          .str('function', 'extractECSTaskInfo')
          .str('eventObj', eventBody)
          .msg('No ECS task ARN found in event');
      }
      return void 0;
    }

    sawAnyEcsArn = true;

    const endIndex = eventBody.indexOf('"', startIndex);
    if (endIndex === -1) {
      log
        .error()
        .str('function', 'extractECSTaskInfo')
        .str('eventObj', eventBody)
        .msg('No ending quote found for ECS ARN');
      return void 0;
    }

    // Extract the candidate ARN
    const arn = eventBody.substring(startIndex, endIndex).trim();

    const arnParts = arn.split('/');
    if (arnParts.length < 3) {
      // Not a task-style ARN (e.g., cluster/ or task-definition/)
      searchIndex = endIndex + 1;
      continue;
    }

    // arnParts[0] example: "arn:aws:ecs:us-west-2:123456789012:task"
    const prefix = arnParts[0];
    if (!prefix.endsWith(':task')) {
      searchIndex = endIndex + 1;
      continue;
    }

    const rawClusterName = arnParts[1];
    const rawTaskId = arnParts[2];

    const clusterName = rawClusterName.replace('"', '').trim();
    const taskId = rawTaskId.replace('"', '').trim();

    log
      .info()
      .str('function', 'extractECSTaskInfo')
      .str('arn', arn)
      .str('clusterName', clusterName)
      .str('taskId', taskId)
      .msg('Extracted ECS task ARN info');

    return {
      arn,
      clusterName,
      taskId,
    };
  }
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
  taskId: string,
  tags: Tag,
): Promise<void> {
  const dimensions: Dimension[] = [
    {Name: 'ClusterName', Value: clusterName},
    // CloudWatch ECS metrics use "ServiceName" as a dimension.
    // Even though we are storing a taskId value here, the dimension
    // NAME must remain "ServiceName" so metrics continue to match.
    {Name: 'ServiceName', Value: taskId},
  ];

  log
    .info()
    .str('function', 'manageEcsAlarms')
    .str('ecsArn', ecsArn)
    .msg('Managing ECS task alarms');

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
    .msg('ECS task alarm management complete');
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
      .msg('Processed ECS metric configuration');
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
    .msg('Deleted obsolete ECS task alarms');
}

/**
 * Entry point to module to manage ECS task alarms.
 */
export async function parseECSEventAndCreateAlarms(
  record: SQSRecord,
): Promise<void> {
  const body = JSON.parse(record.body);

  log
    .info()
    .str('function', 'parseECSEventAndCreateAlarms')
    .str('eventName', body.eventName)
    .msg('Processing ECS event');

  // Step 1: Extract task info from ARN(s) in the event body
  const taskInfo = extractECSTaskInfo(record.body);

  if (!taskInfo) {
    log
      .error()
      .str('function', 'parseECSEventAndCreateAlarms')
      .msg('Failed to extract ECS task info from event');
    throw new Error('No valid ECS task info found in event');
  }

  const {arn: ecsArn, clusterName, taskId} = taskInfo;

  log
    .info()
    .str('function', 'parseECSEventAndCreateAlarms')
    .str('eventName', body.eventName)
    .str('ecsArn', ecsArn)
    .str('clusterName', clusterName)
    .str('taskId', taskId)
    .msg('Processing ECS task event');

  // Step 2: Handle task stop (delete alarms for the stopped task)
  if (body.eventName === 'StopTask') {
    try {
      log
        .info()
        .str('function', 'parseECSEventAndCreateAlarms')
        .str('ecsArn', ecsArn)
        .msg('Deleting alarms for stopped ECS task');
      await deleteExistingAlarms('ECS', ecsArn);
      return;
    } catch (error) {
      log
        .error()
        .str('function', 'parseECSEventAndCreateAlarms')
        .str('ecsArn', ecsArn)
        .err(error)
        .msg('Error deleting ECS alarms for stopped task');
      throw new Error(`Failed to delete alarms for task ${taskId}: ${error}`);
    }
  }

  // Step 3: Fetch and filter tags on the ECS task
  const tags = await fetchEcsTags(ecsArn);

  if (Object.keys(tags).length === 0) {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('ecsArn', ecsArn)
      .msg('No autoalarm tags found on task - skipping alarm management');
    await deleteExistingAlarms('ECS', ecsArn);
    return;
  }

  // Check if AutoAlarm is explicitly disabled
  if (tags['autoalarm:enabled'] === 'false') {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('ecsArn', ecsArn)
      .msg('AutoAlarm disabled for task - deleting existing alarms');
    await deleteExistingAlarms('ECS', ecsArn);
    return;
  }

  // Step 4: Manage alarms for the tagged ECS task
  try {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('ecsArn', ecsArn)
      .num('autoAlarmTagCount', Object.keys(tags).length)
      .msg('Managing ECS task alarms');
    await manageEcsAlarms(ecsArn, clusterName, taskId, tags);
  } catch (error) {
    log
      .error()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('ecsArn', ecsArn)
      .err(error)
      .msg('Error managing ECS task alarms');
    throw new Error(`Failed to manage alarms for ECS task ${taskId}: ${error}`);
  }
}
