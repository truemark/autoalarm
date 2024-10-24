import {Handler} from 'aws-lambda';
import {
  CloudWatchClient,
  paginateDescribeAlarms,
  SetAlarmStateCommand,
  MetricAlarm,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-cloudwatch';
import * as logging from '@nr1e/logging';

const cloudwatch = new CloudWatchClient({});

// Initialize logging
const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'realarm-handler',
  level,
});

async function getAllAlarms() {
  log.info().msg('Getting all alarms');
  // Array to hold all alarms
  const alarms: MetricAlarm[] = [];

  // Setting up the paginator with a page size of 100
  const paginator = paginateDescribeAlarms(
    {
      client: cloudwatch,
      pageSize: 100, // Sets the number of items to return in each page
    },
    {},
  ); // Empty object as we want to get all alarms

  // Loop through each page
  for await (const page of paginator) {
    // Check if the page has alarms and add them to the alarms array
    if (page.MetricAlarms) {
      page.MetricAlarms.forEach((alarm) => alarms.push(alarm));
    }
  }
  log
    .info()
    .msg(
      `Found the following Alarms: ${alarms.map((alarm) => alarm.AlarmName).join(', ')}`,
    );
  log
    .info()
    .num('alarmCount', alarms.length)
    .msg(`Total alarms found: ${alarms.length}`);
  return alarms;
}

async function resetAlarmState(alarmName: string): Promise<void> {
  try {
    await cloudwatch.send(
      new SetAlarmStateCommand({
        AlarmName: alarmName,
        StateValue: 'OK',
        StateReason: 'Resetting state from reAlarm Lambda function',
      }),
    );
  } catch (error) {
    log
      .fatal()
      .str('alarmName', alarmName)
      .msg(`Failed to reset alarm: ${alarmName}. Error: ${error}`);
    throw error;
  }
}

async function checkAndResetAlarms(): Promise<void> {
  const alarms = await getAllAlarms();

  for (const alarm of alarms) {
    const actions: string[] = alarm.AlarmActions || [];
    const alarmARN = alarm.AlarmArn as string;
    const tags = await cloudwatch.send(
      new ListTagsForResourceCommand({ResourceARN: alarmARN}),
    );

    const reAlarmDisabled = tags.Tags?.some(
      (tag) => tag.Key === 'realarm:disabled' && tag.Value === 'true',
    );

    const hasAutoScalingAction = actions.some((action: string) =>
      action.includes('autoscaling'),
    );

    log
      .info()
      .str('alarmName', alarm.AlarmName as string)
      .str('stateValue', alarm.StateValue as string)
      .str('tags', JSON.stringify(tags.Tags))
      .str('reAlarmDisabled', reAlarmDisabled ? 'true' : 'false')
      .str('actions', actions.join(', '))
      .str('hasAutoScalingAction', hasAutoScalingAction ? 'true' : 'false')
      .msg(`Alarm: ${alarm.AlarmName} is in a ${alarm.StateValue} state.`);

    if (
      !hasAutoScalingAction &&
      !reAlarmDisabled &&
      alarm.StateValue === 'ALARM'
    ) {
      log
        .info()
        .msg(
          `${alarm.AlarmName} is in ALARM state. Alarm does not have autoscaling action and realarm is not disabled. Resetting...`,
        );
      try {
        await resetAlarmState(alarm.AlarmName!);
        log
          .info()
          .str('alarmName', alarm.AlarmName as string)
          .msg(`Successfully reset alarm: ${alarm.AlarmName}`);
      } catch (error) {
        log
          .error()
          .str('alarmName', alarm.AlarmName as string)
          .msg(`Failed to reset alarm: ${alarm.AlarmName}. Error: ${error}`);
        throw error;
      }
    } else if (
      (hasAutoScalingAction || reAlarmDisabled) &&
      alarm.StateValue === 'ALARM'
    ) {
      log
        .info()
        .str('alarmName', alarm.AlarmName as string)
        .msg(
          'Skipped resetting alarm due to Auto Scaling action and/or realarm:disabled tag set to "true."',
        );
    }
  }
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler: Handler = async (event: any): Promise<void> => {
  log.trace().unknown('event', event).msg('Received event');
  await checkAndResetAlarms();
};
