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

interface ECSServiceInfo {
  serviceArn: string;
  serviceName: string;
  clusterName: string;
}

function extractECSServiceInfo(
  eventBody: string,
  accountId: string,
): ECSServiceInfo | undefined {
  const searchIndex = 0;
  const region: string = process.env.AWS_REGION!;

  const startIndex = eventBody.indexOf(
    `arn:aws:ecs:${region}:${accountId}:service`,
    searchIndex,
  );
  if (startIndex === -1) {
    log
      .error()
      .str('function', 'extractECSServiceInfo')
      .msg('No ECS Service ARN found in event');
    return void 0;
  }

  const endIndex = eventBody.indexOf('"', startIndex);
  if (endIndex === -1) {
    log
      .error()
      .str('function', 'extractECSServiceInfo')
      .msg('No ending quote found for ECS ARN');
    return void 0;
  }

  const arn = eventBody.substring(startIndex, endIndex).trim();
  const arnParts = arn.split('/');

  if (arnParts.length < 3) {
    log
      .error()
      .str('function', 'extractECSServiceInfo')
      .str('arn', arn)
      .msg('Invalid ECS service ARN format - missing cluster or service name');
    return void 0;
  }

  const clusterName = arnParts[1].trim();
  const serviceName = arnParts[2].trim();

  log
    .info()
    .str('function', 'extractECSServiceInfo')
    .str('serviceArn', arn)
    .str('clusterName', clusterName)
    .str('serviceName', serviceName)
    .msg('Extracted ECS service info');

  return {
    serviceArn: arn,
    serviceName,
    clusterName,
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
  serviceArn: string,
  clusterName: string,
  serviceName: string,
  tags: Tag,
): Promise<void> {
  const dimensions: Dimension[] = [
    {Name: 'ClusterName', Value: clusterName},
    {Name: 'ServiceName', Value: serviceName},
  ];

  log
    .info()
    .str('function', 'manageEcsAlarms')
    .str('serviceArn', serviceArn)
    .msg('Managing ECS service alarms');

  const alarmsToKeep = await createOrUpdateAlarms(
    serviceArn,
    tags,
    'ECS',
    dimensions,
  );

  await deleteUnneededAlarms(serviceArn, alarmsToKeep, 'ECS');

  log
    .info()
    .str('function', 'manageEcsAlarms')
    .num('alarmsManaged', alarmsToKeep.size)
    .msg('ECS service alarm management complete');
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
    .msg('Deleted obsolete ECS service alarms');
}

/**
 * Entry point to module to manage ECS service alarms.
 */
export async function parseECSEventAndCreateAlarms(
  record: SQSRecord,
  accountId: string,
): Promise<void> {
  const body = JSON.parse(record.body);
  const eventName = body.detail?.eventName;

  const serviceInfo = extractECSServiceInfo(record.body, accountId);

  if (!serviceInfo) {
    log
      .error()
      .str('function', 'parseECSEventAndCreateAlarms')
      .msg('Failed to extract ECS service info from event');
    throw new Error('No valid ECS service info found in event');
  }

  const {serviceArn, serviceName, clusterName} = serviceInfo;

  log
    .info()
    .str('function', 'parseECSEventAndCreateAlarms')
    .str('eventName', eventName)
    .str('serviceArn', serviceArn)
    .str('serviceName', serviceName)
    .str('clusterName', clusterName)
    .msg('Processing ECS service event');

  if (eventName === 'DeleteService') {
    try {
      log
        .info()
        .str('function', 'parseECSEventAndCreateAlarms')
        .str('serviceArn', serviceArn)
        .msg('Deleting alarms for deleted ECS service');
      await deleteExistingAlarms('ECS', serviceArn);
      return;
    } catch (error) {
      log
        .error()
        .str('function', 'parseECSEventAndCreateAlarms')
        .str('serviceArn', serviceArn)
        .err(error)
        .msg('Error deleting ECS alarms for deleted service');
      throw new Error(
        `Failed to delete alarms for service ${serviceName}: ${error}`,
      );
    }
  }

  const tags = await fetchEcsTags(serviceArn);

  if (Object.keys(tags).length === 0) {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('serviceArn', serviceArn)
      .msg('No autoalarm tags found - skipping alarm management');
    await deleteExistingAlarms('ECS', serviceArn);
    return;
  }

  if (tags['autoalarm:enabled'] === 'false') {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('serviceArn', serviceArn)
      .msg('AutoAlarm disabled - deleting existing alarms');
    await deleteExistingAlarms('ECS', serviceArn);
    return;
  }

  if (!tags['autoalarm:enabled']) {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('serviceArn', serviceArn)
      .msg(
        'autoalarm:enabled tag not found - skipping alarm management and deleting existing alarms',
      );
    await deleteExistingAlarms('ECS', serviceArn);
    return;
  }

  try {
    log
      .info()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('serviceArn', serviceArn)
      .num('autoAlarmTagCount', Object.keys(tags).length)
      .msg('Managing ECS service alarms');
    await manageEcsAlarms(serviceArn, clusterName, serviceName, tags);
  } catch (error) {
    log
      .error()
      .str('function', 'parseECSEventAndCreateAlarms')
      .str('serviceArn', serviceArn)
      .err(error)
      .msg('Error managing ECS service alarms');
    throw new Error(
      `Failed to manage alarms for service ${serviceName}: ${error}`,
    );
  }
}
