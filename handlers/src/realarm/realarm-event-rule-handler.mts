import {Handler} from 'aws-lambda';
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  MetricAlarm,
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
const cloudwatch = new CloudWatchClient({});
const eventbridge = new EventBridgeClient({});

/**
 * Retrieves CloudWatch Alarm details from a given ARN
 * @param alarmArn - The ARN of the CloudWatch Alarm
 * @returns The MetricAlarm object if found, null otherwise
 */
async function getAlarmFromArn(alarmArn: string): Promise<MetricAlarm | null> {
  try {
    const {MetricAlarms} = await cloudwatch.send(
      new DescribeAlarmsCommand({
        AlarmNames: [alarmArn.split(':alarm:')[1]],
      }),
    );
    return MetricAlarms?.[0] ?? null;
  } catch (error) {
    log
      .error()
      .str('function', 'getAlarmFromArn')
      .str('alarmArn', alarmArn)
      .msg(`Error fetching alarm: ${error}`);
    return null;
  }
}

/**
 * Deletes an EventBridge rule and its targets
 * @param alarmName - The name of the CloudWatch Alarm
 */
async function deleteEventBridgeRule(alarmName: string): Promise<void> {
  const ruleName = `AutoAlarm-ReAlarm-${alarmName}`;

  try {
    // Remove targets before deleting the rule
    await eventbridge.send(
      new RemoveTargetsCommand({
        Rule: ruleName,
        Ids: [`Target-${alarmName}`],
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
  const ruleName = `AutoAlarm-ReAlarm-${alarmName}`;

  try {
    await Promise.all([
      eventbridge.send(
        new PutRuleCommand({
          Name: ruleName,
          Description: `Re-alarm rule for ${alarmName} every ${minutes} minutes`,
          ScheduleExpression: `rate(${minutes} minutes)`,
          State: 'ENABLED',
        }),
      ),
      eventbridge.send(
        new PutTargetsCommand({
          Rule: ruleName,
          Targets: [
            {
              Id: `Target-${alarmName}`,
              Arn: lambdaArn,
              Input: JSON.stringify({
                event: {'reAlarmOverride-AlarmName': alarmName},
              }),
            },
          ],
        }),
      ),
    ]);

    log
      .info()
      .str('function', 'createEventBridgeRule')
      .str('ruleArn', lambdaArn)
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

/**
 * Lambda handler that processes CloudWatch Alarm tag changes.
 * When a tag with key 'autoalarm:re-alarm-minutes' is added/modified:
 * 1. Validates the tag value is a positive number
 * 2. Retrieve alarm details
 * 3. Create an EventBridge rule to trigger the re-alarm function on the specified schedule
 *
 * When the tag is removed or invalid:
 * 1. Deletes any existing EventBridge rule for the alarm
 */
export const handler: Handler = async (event) => {
  log.trace().unknown('event', event).msg('Received event');
  const {resourceARN, tags} = event.detail.requestParameters as {
    resourceARN: string;
    tags: Tag[];
  };

  // Get alarm details first to ensure we have a valid alarm
  const alarm = await getAlarmFromArn(resourceARN);
  if (!alarm?.AlarmName) {
    log
      .error()
      .str('function', 'handler')
      .str('resourceARN', resourceARN)
      .msg('Alarm not found');
    return;
  }

  // Extract and validate the minutes value from the tag
  const minutes = Number(tags.find((t) => t.Key === TAG_KEY)?.Value);
  if (!minutes || minutes <= 0 || !Number.isInteger(minutes)) {
    log
      .info()
      .str('function', 'handler')
      .str('resourceARN', resourceARN)
      .msg('Invalid or missing tag value - deleting existing rule');

    // Delete the rule if tag is invalid or missing
    await deleteEventBridgeRule(alarm.AlarmName);
    return;
  }

  // Create/update the EventBridge rule with the specified schedule
  await createEventBridgeRule(alarm.AlarmName, minutes, reAlarmARN);
};
