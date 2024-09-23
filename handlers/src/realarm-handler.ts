import {
  CloudWatchClient,
  paginateDescribeAlarms,
  SetAlarmStateCommand
} from "@aws-sdk/client-cloudwatch";
import * as logging from '@nr1e/logging';

const cloudwatch = new CloudWatchClient({});

// Initialize logging
const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'main-handler',
  level,
});

async function getAllAlarms() {
  log.info().msg('Getting all alarms');
   // Array to hold all alarms
    const alarms: any[] = [];

    // Setting up the paginator with a page size of 100
    const paginator = paginateDescribeAlarms({
        client: cloudwatch,
        pageSize: 100 // Sets the number of items to return in each page
    }, {}); // Empty object as we want to get all alarms

    // Loop through each page
    for await (const page of paginator) {
        // Check if the page has alarms and add them to the alarms array
        if (page.MetricAlarms) {
            page.MetricAlarms.forEach(alarm => alarms.push(alarm));
        }
    }
    log
        .info()
        .msg(`Found the following Alarms: ${alarms.map(alarm => alarm.AlarmName).join(', ')}`);
    log
          .info()
          .num('alarmCount', alarms.length)
          .msg(`Total alarms found: ${alarms.length}`);
  return alarms;
}

async function resetAlarmState(alarmName: string): Promise<void> {
  try {
    log
        .info()
        .str('alarmName', alarmName)
        .msg(`Resetting alarm: ${alarmName}`);
    await cloudwatch.send(
      new SetAlarmStateCommand({
        AlarmName: alarmName,
        StateValue: "OK",
        StateReason: "Resetting state from reAlarm Lambda function",
      })
    );
    log
        .info()
        .str('alarmName', alarmName)
        .msg(`Successfully reset alarm: ${alarmName}`);
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
    log
        .info()
        .str('alarmName', alarm.AlarmName as string)
        .str('stateValue', alarm.StateValue as string)
        .str('actions', actions.join(', '))
        .msg(`Alarm: ${alarm.AlarmName} is in a ${alarm.StateValue} state and has the following actions: ${actions}`);

    const hasAutoScalingAction = actions.some((action: string) => action.includes("autoscaling"));

    if (!hasAutoScalingAction && alarm.StateValue === "ALARM") {
      log
            .info()
            .str('alarmName', alarm.AlarmName as string)
            .msg(`${alarm.AlarmName} is in ALARM state. Resetting...`);
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
    } else if (hasAutoScalingAction && alarm.StateValue === "ALARM") {
      log
          .info()
          .str('alarmName', alarm.AlarmName as string)
          .msg('Skipped resetting alarm due to Auto Scaling action.');
    }
  }
}

export async function handler(event: any, context: any): Promise<void> {
  log.trace().unknown('event', event).msg('Received event');
  await checkAndResetAlarms();
}
