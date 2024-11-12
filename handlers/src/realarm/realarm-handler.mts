import {Handler} from 'aws-lambda';
import {
  CloudWatchClient,
  paginateDescribeAlarms,
  SetAlarmStateCommand,
  MetricAlarm,
  ListTagsForResourceCommand,
  DescribeAlarmsCommand,
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

// TODO: filter out alarm if it has the tag autoalarm:re-alarm-enabled set to false
async function getOverriddenAlarm(alarmName: string): Promise<MetricAlarm[]> {
  try {
    const response = await cloudwatch.send(
      new DescribeAlarmsCommand({AlarmNames: [alarmName]}),
    );
    // Return the MetricAlarms array from the response
    return response.MetricAlarms || [];
  } catch (error) {
    console.error(`Failed to get alarm: ${alarmName}`, error);
    throw error; // Rethrow the error so it can be handled upstream
  }
}

//TODO: filter out alarms with the tag autoalarm:re-alarm-enabled set to false and alarms with the tag autoalarm:re-alarm-minutes set to a number
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

// TODO: moving a lot of the filter logic for the reAlarmOverride conditions into getAllAlarms function so we can just define the alarms array and loop through that and check base conditions
async function checkAndResetAlarms(
  reAlarmOverride: boolean,
  overrideAlarmName?: string,
): Promise<void> {
  // If reAlarmOverride is true, get the alarm with the specified name in the payload else get all alarms
  const alarms: MetricAlarm[] = reAlarmOverride
    ? await getOverriddenAlarm(overrideAlarmName!)
    : await getAllAlarms();

  await Promise.all(
    alarms.map(async (alarm) => {
      const alarmName = alarm.AlarmName as string;
      const alarmState = alarm.StateValue as string;
      const actions = alarm.AlarmActions || [];
      const tags = await cloudwatch.send(
        new ListTagsForResourceCommand({ResourceARN: alarm.AlarmArn as string}),
      );

      const reAlarmConditions = {
        reAlarmDisabled: tags.Tags?.some(
          (tag) =>
            tag.Key === 'autoalarm:re-alarm-enabled' && tag.Value === 'false',
        ) ?? false,
        reAlarmOverrideTag: tags.Tags?.some(
          (tag) =>
            tag.Key === 'autoalarm:re-alarm-minutes' &&
            !isNaN(Number(tag.Value)),
        ) ?? false,
        hasAutoScalingAction: actions.some((action) =>
          action.includes('autoscaling'),
        ),
      };

      log
        .info()
        .str('alarmName', alarmName)
        .str('stateValue', alarmState)
        .str('tags', JSON.stringify(tags.Tags))
        .str('reAlarmDisabled', String(reAlarmConditions.reAlarmDisabled))
        .str(
          'isReAlarmOverride',
          reAlarmConditions.reAlarmOverrideTag
            ? 'ReAlarm Default Schedule is Overriden'
            : 'false',
        )
        .str('actions', actions.join(', '))
        .str('hasAutoScalingAction', String(reAlarmConditions.hasAutoScalingAction))
        .msg(`Alarm: ${alarmName} is in a ${alarmState} state.`);

      const baseConditions =
        alarmState === 'ALARM' &&
        !reAlarmConditions.hasAutoScalingAction &&
        !reAlarmConditions.reAlarmDisabled;

      const shouldReset: boolean = reAlarmOverride
        ? baseConditions && reAlarmConditions.reAlarmOverrideTag
        : baseConditions && !reAlarmConditions.reAlarmOverrideTag;

      if (shouldReset) {
        log
          .info()
          .msg(
            `${alarmName} is in ALARM state. Alarm does not have autoscaling action and realarm is not disabled. Resetting...`,
          );

        try {
          await resetAlarmState(alarmName);
          log
            .info()
            .str('alarmName', alarmName)
            .msg(`Successfully reset alarm: ${alarmName}`);
        } catch (error) {
          log
            .error()
            .str('alarmName', alarmName)
            .msg(`Failed to reset alarm: ${alarmName}. Error: ${error}`);
          throw error;
        }
      } else if (
        (reAlarmConditions.hasAutoScalingAction || reAlarmConditions.reAlarmDisabled) &&
        alarmState === 'ALARM'
      ) {
        log
          .info()
          .str('alarmName', alarmName)
          .msg(
            'Skipped resetting alarm due to Auto Scaling action and/or realarm:disabled tag set to "true."',
          );
      }
    }),
  );
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler: Handler = async (event: any): Promise<void> => {
  log.trace().unknown('event', event).msg('Received event');
  // if a reAlarm override event rule is triggered, only reset the alarm with the specified name in the payload.
  if (event['reAlarmOverride-AlarmName']) {
    await checkAndResetAlarms(true, event['reAlarmOverride-AlarmName']);
    return;
  } else {
    await checkAndResetAlarms(false);
  }
};
