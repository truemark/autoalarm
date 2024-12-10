import {Handler} from 'aws-lambda';
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  Tag,
} from '@aws-sdk/client-cloudwatch';
import {
  EventBridgeClient,
  PutTargetsCommand,
  PutRuleCommand,
  DeleteRuleCommand,
  RemoveTargetsCommand,
} from '@aws-sdk/client-eventbridge';
import * as logging from '@nr1e/logging';
import * as crypto from 'crypto';

// Initialize logging
const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'realarm-event-rule-handler',
  level,
});

// Configuration constants
const TAG_KEY = 'autoalarm:re-alarm-minutes';
const reAlarmARN =
  process.env.RE_ALARM_FUNCTION_ARN ??
  (() => {
    throw new Error('RE_ALARM_FUNCTION_ARN required');
  })();

// Initialize AWS service clients
const eventbridge = new EventBridgeClient({});

/**
 * Creates a consistent hash from alarm name
 * @param alarmName - The full alarm name to hash
 * @returns A 6-character hash string
 */
function createAlarmHash(alarmName: string): string {
  return crypto
    .createHash('md5')
    .update(alarmName)
    .digest('hex')
    .substring(0, 6);
}

/**
 * Deletes an EventBridge rule and its targets
 * @param alarmName - The name of the CloudWatch Alarm
 */
async function deleteEventBridgeRule(alarmName: string): Promise<void> {
  const sanitizedName = alarmName
    .replace(/[^a-zA-Z0-9\-_]/g, '-')
    .substring(0, 32);

  const hashSuffix = createAlarmHash(alarmName);

  const ruleName = `AutoAlarm-ReAlarm-${sanitizedName}-${hashSuffix}`;
  const targetId = `Target-${sanitizedName}-${hashSuffix}`;

  try {
    // Remove targets before deleting the rule
    await eventbridge.send(
      new RemoveTargetsCommand({
        Rule: ruleName,
        Ids: [targetId],
      }),
    );

    await eventbridge.send(
      new DeleteRuleCommand({
        Name: ruleName,
      }),
    );

    log
      .info()
      .str('function', 'deleteEventBridgeRule')
      .str('ruleName', ruleName)
      .msg('Successfully deleted EventBridge rule');
  } catch (error) {
    log
      .error()
      .str('function', 'deleteEventBridgeRule')
      .str('alarmName', alarmName)
      .msg(`Error deleting rule: ${error}`);
    throw error;
  }
}

/**
 * Creates an EventBridge rule that triggers a Lambda function on a schedule
 * @param alarmName - The name of the CloudWatch Alarm
 * @param minutes - The interval in minutes for the rule to trigger
 * @param lambdaArn - The ARN of the Lambda function to trigger
 */
async function createEventBridgeRule(
  alarmName: string,
  minutes: number,
  lambdaArn: string,
): Promise<void> {
  // Generate a hashed 6-character suffix
  const hashSuffix = createAlarmHash(alarmName);

  // Sanitize the alarm name for use in rule name and target ID
  // Limit to 32 characters to accommodate suffix to avoid eventbridge rule name collision
  const sanitizedName = alarmName
    .replace(/[^a-zA-Z0-9\-_]/g, '-')
    .replace(/AutoAlarm-/, '')
    .substring(0, 32); // Reduced to 32 to accommodate suffix

  const ruleName = `AutoAlarm-ReAlarm-${sanitizedName}-${hashSuffix}`;
  const targetId = `Target-${sanitizedName}-${hashSuffix}`;
  const rateUnit = minutes === 1 ? 'minute' : 'minutes';

  try {
    // Create the rule first
    await eventbridge.send(
      new PutRuleCommand({
        Name: ruleName,
        Description: `Re-alarm rule for ${alarmName} every ${minutes} minutes`,
        ScheduleExpression: `rate(${minutes} ${rateUnit})`,
        State: 'ENABLED',
      }),
    );

    // Then add the target
    await eventbridge.send(
      new PutTargetsCommand({
        Rule: ruleName,
        Targets: [
          {
            Id: targetId,
            Arn: lambdaArn,
            Input: JSON.stringify({
              event: {'reAlarmOverride-AlarmName': alarmName},
            }),
          },
        ],
      }),
    );

    log
      .info()
      .str('function', 'createEventBridgeRule')
      .str('ruleName', ruleName)
      .msg(`Created rule: ${ruleName}`);
  } catch (error) {
    log
      .error()
      .str('function', 'createEventBridgeRule')
      .str('alarmName', alarmName)
      .msg(`Error creating rule: ${error}`);
    throw error;
  }
}

function validateEvent(event: {
  resources: string[];
  detail: {tags: {[s: string]: unknown} | ArrayLike<unknown>};
}): {resourceARN: string; tags: Tag[]} {
  if (!event?.resources?.[0]) {
    throw new Error('Invalid event structure: Missing resource ARN');
  }

  if (!event?.detail?.tags) {
    throw new Error('Invalid event structure: Missing tags object');
  }

  // Convert the tags object to the Tag array format
  const tags: Tag[] = Object.entries(event.detail.tags).map(([Key, Value]) => ({
    Key,
    Value: String(Value),
  }));

  return {
    resourceARN: event.resources[0],
    tags,
  };
}

/**
 * Lambda handler that processes CloudWatch Alarm tag changes.
 * When a tag with key 'autoalarm:re-alarm-minutes' is added/modified:
 * 1. Validates the tag value is a positive number
 * 2. Retrieve alarm details
 * 3. Create an EventBridge rule to trigger the re-alarm function on the specified schedule
 *
 * When the tag is removed or invalid:
 * 1. Delete any existing EventBridge rule for the alarm
 */
export const handler: Handler = async (event) => {
  log.trace().unknown('event', event).msg('Received event');

  try {
    // Validate event structure and convert tags format
    const {resourceARN, tags} = validateEvent(event);

    // Get alarm details first to ensure we have a valid alarm
    const alarmArn = event.resources[0]; // Get the first ARN from resources array
    const alarmName = alarmArn.split(':alarm:')[1]; // Extract alarm name from ARN
    try {
      const {MetricAlarms} = await new CloudWatchClient({}).send(
        new DescribeAlarmsCommand({
          AlarmNames: [alarmName],
        }),
      );
      log
        .info()
        .str('function', 'handler')
        .str('resourceARN', resourceARN)
        .obj('MetricAlarms', MetricAlarms)
        .msg('Alarm details');
      if (!MetricAlarms) {
        log
          .info()
          .str('function', 'handler')
          .str('resourceARN', resourceARN)
          .msg('Alarm not found. Deleting any associated eventbridge rules');
        await deleteEventBridgeRule(alarmName);
        return;
      }
    } catch (error) {
      log
        .error()
        .str('function', 'handler')
        .str('resourceARN', resourceARN)
        .unknown('error', error)
        .msg('Error fetching alarm details');
    }

    // Extract and validate the minutes value from the tag
    const reAlarmTag = tags.find((t) => t.Key === TAG_KEY);
    const minutes = reAlarmTag ? Number(reAlarmTag.Value) : null;

    if (!minutes || minutes <= 0 || !Number.isInteger(minutes)) {
      log
        .info()
        .str('function', 'handler')
        .str('resourceARN', resourceARN)
        .msg('Invalid or missing tag value - deleting existing rule');

      // Delete the rule if tag is invalid or missing
      await deleteEventBridgeRule(alarmName);
      return;
    }

    // Create/update the EventBridge rule with the specified schedule
    await createEventBridgeRule(alarmName, minutes, reAlarmARN);
  } catch (error) {
    log
      .error()
      .str('function', 'handler')
      .unknown('error', error)
      .msg('Error processing event');
    throw error;
  }
};
