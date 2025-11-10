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
import {  SQSRecord,
} from 'aws-lambda';
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

export async function fetchEcsTags(sfnArn: string): Promise<Tag> {
  try {
    const command = new ListTagsForResourceCommand({
      resourceArn: sfnArn,
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
      .str('sfnArn', sfnArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched tags for SFN Arn');
    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchEcsTags')
      .str('sfnArn', sfnArn)
      .err(error)
      .msg('Error fetching tags for SFN Arn');
    return {};
  }
}

async function checkAndManageEcsStatusAlarms(
  ecsArn: string,
  tags: Tag,
): Promise<void> {
  log
    .info()
    .str('function', 'checkAndManageEcsStatusAlarms')
    .str('ecsArn', ecsArn)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageEcsStatusAlarms')
      .str('sfnArn', ecsArn)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('SFN', ecsArn);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageEcsStatusAlarms')
      .obj('config', config)
      .str('sfnArn', ecsArn)
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
          .str('function', 'checkAndManageEcsStatusAlarms')
          .str('ecsArn', ecsArn)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          'ECS',
          ecsArn,
          [{Name: 'StateMachineArn', Value: ecsArn}],
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageEcsStatusAlarms')
          .str('sfnArn', ecsArn)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          'SFN',
          ecsArn,
          [{Name: 'StateMachineArn', Value: ecsArn}],
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageEcsStatusAlarms')
        .str('sfnArn', ecsArn)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            'SFN',
            ecsArn,
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
  const existingAlarms = await getCWAlarmsForInstance('SFN', ecsArn);

  // Log the full structure of retrieved alarms for debugging
  log
    .info()
    .str('function', 'checkAndManageEcsStatusAlarms')
    .obj('raw existing alarms', existingAlarms)
    .msg('Fetched existing alarms before filtering');

  // Log the expected pattern
  const expectedPattern = `AutoAlarm-SFN-${ecsArn}`;
  log
    .info()
    .str('function', 'checkAndManageEcsStatusAlarms')
    .str('expected alarm pattern', expectedPattern)
    .msg('Verifying alarms against expected naming pattern');

  // Check and log if alarms match expected pattern
  existingAlarms.forEach((alarm) => {
    const matchesPattern = alarm.includes(expectedPattern);
    log
      .info()
      .str('function', 'checkAndManageEcsStatusAlarms')
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
    .str('function', 'checkAndManageEcsStatusAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarms that are no longer needed');

  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageEcsStatusAlarms')
    .str('sfnArn', ecsArn)
    .msg('Finished alarm management process');
}

export async function manageInactiveECSAlarms(sfnArn: string): Promise<void> {
  try {
    await deleteExistingAlarms('SFN', sfnArn);
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
function findECSClusterInfo(eventObj: SQSRecord): Record<string, string> | undefined {
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
      .msg('No ending quote found for SFN ARN');
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
    .msg('Extracted SFN ARN');

  // 4) Extract Cluster name from ARN and return
  return {
    arn: arn,
    clusterName: arn.split('/')[1].replace('"', '').trim()
  };

}

/**
 * Fetches services which are needed for the cloudwatch ecs memory dimensions
 * @param cluster
 */
async function  fetchEcsServices(cluster: string, nextToken?: string | undefined ): Promise<string[] | undefined> {
  // Place holder for return token if result remain after the previous api call
  const input = {
    cluster: cluster,
    nextToken: nextToken
  }

  // get response and then store in services string[]
  let services: string[] = [];
  const response: ListServicesCommandOutput = await ecsClient.send(
    new ListServicesCommand(input)
  )

  services.push(...response.serviceArns!);

  // Recursive loop if next token exists
  if (response.nextToken) {
    const nextServices = await fetchEcsServices(cluster, response.nextToken);
    if (nextServices) {
      services.push(...nextServices);
    }
  }

  // If no next token, return all discovered services or undefined if services is empty
  return services.every((service) => service != void 0)
    ? services
      : void 0
}

export async function parseECSEventAndCreateAlarms(
  event: SQSRecord,
): Promise<{
  sfnArn: string;
  eventType: string;
  tags: Record<string, string>;
} | void> {
  let sfnArn: string | Error = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event.body['detail-type']) { // TODO:
    case 'Tag Change on Resource':
      sfnArn = findECSClusterInfo(event);
      if (!sfnArn) {
        log
          .error()
          .str('function', 'parseSFNEventAndCreateAlarms')
          .obj('event', event)
          .msg('No SFN ARN found in event for tag change event');
        throw new Error('No SFN ARN found in event');
      }
      eventType = 'TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseSFNEventAndCreateAlarms')
        .str('eventType', 'TagChange')
        .str('sfnArn', sfnArn)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');

      if (sfnArn) {
        tags = await fetchEcsTags(sfnArn);
        log
          .info()
          .str('function', 'parseSFNEventAndCreateAlarms')
          .str('sfnArn', sfnArn)
          .str('tags', JSON.stringify(tags))
          .msg('Fetched tags for new TagChange event');
      } else {
        log
          .error()
          .str('function', 'parseSFNEventAndCreateAlarms')
          .str('eventType', 'TagChance')
          .msg('SFN ARN not found in Tag Change event');
        throw new Error('SFN ARN not found in Tag Change event');
      }
      break;

    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateStateMachine':
          sfnArn = findECSClusterInfo(event);
          if (!sfnArn) {
            log
              .error()
              .str('function', 'parseSFNEventAndCreateAlarms')
              .obj('event', event)
              .msg('No SFN ARN found in event for CreateStateMachine event');
            throw new Error(
              'No SFN ARN found in event for AWS API Call via CloudTrail event',
            );
          }
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseSFNEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('sfnArn', sfnArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateStateMachine event');
          if (sfnArn) {
            tags = await fetchEcsTags(sfnArn);
            log
              .info()
              .str('function', 'parseSFNEventAndCreateAlarms')
              .str('sfnArn', sfnArn)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new CreateStateMachine event');
          } else {
            log
              .error()
              .str('function', 'parseSFNEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('SFN ARN not found in CreateStateMachine event');
            throw new Error('SFN ARN not found in CreateStateMachine event');
          }
          break;

        case 'DeleteStateMachine':
          sfnArn = findECSClusterInfo(event);
          if (!sfnArn) {
            log
              .error()
              .str('function', 'parseSFNEventAndCreateAlarms')
              .obj('event', event)
              .msg('No SFN ARN found in event for DeleteStateMachine event');
            throw new Error(
              'No SFN ARN found in event for AWS API Call via CloudTrail event',
            );
          }
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseSFNEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('sfnArn', sfnArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteStateMachine event');
          break;

        default:
          log
            .error()
            .str('function', 'parseSFNEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
          throw new Error('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .error()
        .str('function', 'parseSFNEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
      throw new Error('Unexpected event type');
  }

  if (!sfnArn) {
    log
      .error()
      .str('function', 'parseSFNEventAndCreateAlarms')
      .str('sfnArn', sfnArn)
      .msg('sfnArn is empty');
    throw new Error('sfnArn is empty');
  }

  log
    .info()
    .str('function', 'parseSFNEventAndCreateAlarms')
    .str('sfnArn', sfnArn)
    .str('eventType', eventType)
    .msg('Finished processing SFN event');

  if (sfnArn && (eventType === 'Create' || eventType === 'TagChange')) {
    log
      .info()
      .str('function', 'parseSFNEventAndCreateAlarms')
      .str('sfnArn', sfnArn)
      .str('tags', JSON.stringify(tags))
      .str(
        'autoalarm:enabled',
        tags['autoalarm:enabled']
          ? tags['autoalarm:enabled']
          : 'autoalarm tag does not exist',
      )
      .msg('Starting to manage SFN alarms');
    await checkAndManageEcsStatusAlarms(sfnArn, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseSFNEventAndCreateAlarms')
      .str('sfnArn', sfnArn)
      .msg('Starting to manage inactive SFN alarms');
    await manageInactiveECSAlarms(sfnArn);
  }

  return {sfnArn, eventType, tags};
}
