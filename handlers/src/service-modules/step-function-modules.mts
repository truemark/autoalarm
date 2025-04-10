import {SFNClient, ListTagsForResourceCommand} from '@aws-sdk/client-sfn';
import * as logging from '@nr1e/logging';
import {Tag} from '../types/module-types.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {AlarmClassification} from '../types/enums.mjs';
import {
  getCWAlarmsForInstance,
  deleteExistingAlarms,
  buildAlarmName,
  handleAnomalyAlarms,
  handleStaticAlarms,
} from '../alarm-configs/utils/cloudwatch/alarm-tools.mjs';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  AlarmConfigs,
  parseMetricAlarmOptions,
} from '../alarm-configs/utils/cloudwatch/alarm-config.mjs';

const log: logging.Logger = logging.getLogger('step-function-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const sfnClient: SFNClient = new SFNClient({
  region: region,
  retryStrategy: retryStrategy,
});
const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region: region,
  retryStrategy: retryStrategy,
});

const metricConfigs = AlarmConfigs['StepFunctions'];

export async function fetchSFNTags(sfnArn: string): Promise<Tag> {
  try {
    const command = new ListTagsForResourceCommand({
      resourceArn: sfnArn,
    });
    const response = await sfnClient.send(command);
    const tags: Tag = {};

    response.tags?.forEach((tag) => {
      if (tag.key && tag.value) {
        tags[tag.key] = tag.value;
      }
    });

    log
      .info()
      .str('function', 'fetchSFNTags')
      .str('sfnArn', sfnArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched tags for SFN Arn');
    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchSFNTags')
      .str('sfnArn', sfnArn)
      .err(error)
      .msg('Error fetching tags for SFN Arn');
    return {};
  }
}

async function checkAndManageSFNStatusAlarms(
  sfnArn: string,
  tags: Tag,
): Promise<void> {
  log
    .info()
    .str('function', 'checkAndManageSFNStatusAlarms')
    .str('sfnArn', sfnArn)
    .msg('Starting alarm management process');

  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';
  if (!isAlarmEnabled) {
    log
      .info()
      .str('function', 'checkAndManageSFNStatusAlarms')
      .str('sfnArn', sfnArn)
      .msg('Alarm creation disabled by tag settings');
    await deleteExistingAlarms('SFN', sfnArn);
    return;
  }

  const alarmsToKeep = new Set<string>();

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageSFNStatusAlarms')
      .obj('config', config)
      .str('sfnArn', sfnArn)
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
          .str('function', 'checkAndManageSFNStatusAlarms')
          .str('sfnArn', sfnArn)
          .msg('Tag key indicates anomaly alarm. Handling anomaly alarms');
        const anomalyAlarms = await handleAnomalyAlarms(
          config,
          'SFN',
          sfnArn,
          [{Name: 'StateMachineArn', Value: sfnArn}],
          updatedDefaults,
        );
        anomalyAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .info()
          .str('function', 'checkAndManageSFNStatusAlarms')
          .str('sfnArn', sfnArn)
          .msg('Tag key indicates static alarm. Handling static alarms');
        const staticAlarms = await handleStaticAlarms(
          config,
          'SFN',
          sfnArn,
          [{Name: 'StateMachineArn', Value: sfnArn}],
          updatedDefaults,
        );
        staticAlarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      }
    } else {
      log
        .info()
        .str('function', 'checkAndManageSFNStatusAlarms')
        .str('sfnArn', sfnArn)
        .str(
          'alarm prefix: ',
          buildAlarmName(
            config,
            'SFN',
            sfnArn,
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
  const existingAlarms = await getCWAlarmsForInstance('SFN', sfnArn);

  // Log the full structure of retrieved alarms for debugging
  log
    .info()
    .str('function', 'checkAndManageSFNStatusAlarms')
    .obj('raw existing alarms', existingAlarms)
    .msg('Fetched existing alarms before filtering');

  // Log the expected pattern
  const expectedPattern = `AutoAlarm-SFN-${sfnArn}`;
  log
    .info()
    .str('function', 'checkAndManageSFNStatusAlarms')
    .str('expected alarm pattern', expectedPattern)
    .msg('Verifying alarms against expected naming pattern');

  // Check and log if alarms match expected pattern
  existingAlarms.forEach((alarm) => {
    const matchesPattern = alarm.includes(expectedPattern);
    log
      .info()
      .str('function', 'checkAndManageSFNStatusAlarms')
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
    .str('function', 'checkAndManageSFNStatusAlarms')
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting alarms that are no longer needed');

  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...alarmsToDelete],
    }),
  );

  log
    .info()
    .str('function', 'checkAndManageSFNStatusAlarms')
    .str('sfnArn', sfnArn)
    .msg('Finished alarm management process');
}

export async function manageInactiveRDSAlarms(sfnArn: string): Promise<void> {
  try {
    await deleteExistingAlarms('SFN', sfnArn);
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveRDSAlarms')
      .err(e)
      .msg(`Error deleting SFN alarms: ${e}`);
  }
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
function findSFNArn(eventObj: Record<string, any>): string {
  const eventString = JSON.stringify(eventObj);

  // 1) Find where the ARN starts.
  const startIndex = eventString.indexOf('arn:aws:states');
  if (startIndex === -1) {
    log
      .error()
      .str('function', 'findSFNArn')
      .obj('eventObj', eventObj)
      .msg('No SFN ARN found in event');
    return '';
  }

  // 2) Find the next quote after that.
  const endIndex = eventString.indexOf('"', startIndex);
  if (endIndex === -1) {
    log
      .error()
      .str('function', 'findSFNArn')
      .obj('eventObj', eventObj)
      .msg('No ending quote found for SFN ARN');
    return '';
  }

  // 3) Extract the ARN
  const arn = eventString.substring(startIndex, endIndex);

  log
    .info()
    .str('function', 'findSFNArn')
    .str('arn', arn)
    .str('startIndex', startIndex.toString())
    .str('endIndex', endIndex.toString())
    .msg('Extracted SFN ARN');

  return arn;
}

export async function parseSFNEventAndCreateAlarms(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: Record<string, any>,
): Promise<{
  sfnArn: string;
  eventType: string;
  tags: Record<string, string>;
} | void> {
  let sfnArn: string | Error = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      sfnArn = findSFNArn(event);
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
        tags = await fetchSFNTags(sfnArn);
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
          sfnArn = findSFNArn(event);
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
            tags = await fetchSFNTags(sfnArn);
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
          sfnArn = findSFNArn(event);
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
    await checkAndManageSFNStatusAlarms(sfnArn, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseSFNEventAndCreateAlarms')
      .str('sfnArn', sfnArn)
      .msg('Starting to manage inactive SFN alarms');
    await manageInactiveRDSAlarms(sfnArn);
  }

  return {sfnArn, eventType, tags};
}
