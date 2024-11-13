import { Handler } from 'aws-lambda';
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
} from '@aws-sdk/client-eventbridge';
import * as logging from '@nr1e/logging';

// Initialize logging
// Set up logging configuration with fallback to 'trace' level
const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'realarm-event-rule-handler',
  level,
});

// Constants
const TAG_KEY = 'autoalarm:re-alarm-minutes';
const reAlarmARN = process.env.RE_ALARM_FUNCTION_ARN;
if (!reAlarmARN) {
  throw new Error('Environment variable RE_ALARM_FUNCTION_ARN is required');
}

// AWS clients
const cloudwatch = new CloudWatchClient({});
const eventbridge = new EventBridgeClient({});

async function getAlarmFromArn(alarmArn: string): Promise<MetricAlarm | null> {
  try {
    const response = await cloudwatch.send(
      new DescribeAlarmsCommand({ AlarmNames: [alarmArn.split(':alarm:')[1]] }),
    );
    return response.MetricAlarms?.[0] || null;
  } catch (error) {
    log.error().str('alarmArn', alarmArn).msg(`Error fetching alarm: ${error}`);
    return null;
  }
}

async function createEventBridgeRule(
  alarmName: string,
  minutes: number,
  lambdaArn: string, // Accept the Lambda ARN as a parameter
): Promise<void> {
  const ruleName = `AutoAlarm-ReAlarm-${alarmName}`;
  const scheduleExpression = `rate(${minutes} minutes)`;

  try {
     await eventbridge.send(
      new PutRuleCommand({
        Name: ruleName,
        Description: `Re-alarm rule for ${alarmName} every ${minutes} minutes`,
        ScheduleExpression: scheduleExpression,
        State: 'ENABLED',
      }),
    );

    await eventbridge.send(
      new PutTargetsCommand({
        Rule: ruleName,
        Targets: [
          {
            Id: `Target-${alarmName}`,
            Arn: lambdaArn, // Use the ARN passed as a parameter
            Input: JSON.stringify({ event: { 'reAlarmOverride-AlarmName': alarmName } }),
          },
        ],
      }),
    );

    log.info().str('ruleArn', lambdaArn).msg(`Created EventBridge rule: ${ruleName}`);
  } catch (error) {
    log.error().str('alarmName', alarmName).msg(`Error creating rule: ${error}`);
    throw error;
  }
}


export const handler: Handler = async (event) => {
  log.trace().unknown('event', event).msg('Processing event');

  const { resourceARN, tags } = event.detail.requestParameters as {
    resourceARN: string;
    tags: Tag[];
  };

  const tag = tags.find((t) => t.Key === TAG_KEY);
  if (!tag?.Value || isNaN(Number(tag.Value)) || Number(tag.Value) <= 0) {
    log.debug().str('resourceARN', resourceARN).msg('Invalid or missing tag value');
    return;
  }

  const alarm = await getAlarmFromArn(resourceARN);
  if (!alarm) {
    log.error().str('resourceARN', resourceARN).msg('Alarm not found');
    return;
  }

  await createEventBridgeRule(alarm.AlarmName!, Number(tag.Value), reAlarmARN);
};

