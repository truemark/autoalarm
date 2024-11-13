import {Handler} from 'aws-lambda';
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  ListTagsForResourceCommand,
  MetricAlarm,
  paginateDescribeAlarms,
  SetAlarmStateCommand,
} from '@aws-sdk/client-cloudwatch';
import * as logging from '@nr1e/logging';

/**
 * AWS Lambda function that manages CloudWatch alarms by resetting their states based on specific conditions.
 * The function can handle both standard scheduled resets and override-specific alarm resets.
 */

// Initialize CloudWatch client
const cloudwatch = new CloudWatchClient({});

// Set up logging configuration with fallback to 'trace' level
const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'realarm-handler',
  level,
});

/**
 * Interface defining the conditions that determine how an alarm should be handled
 */
interface ReAlarmConditions {
  reAlarmDisabled: boolean;      // Indicates if re-alarming is disabled via tags
  reAlarmOverrideTag: boolean;   // Indicates if custom re-alarm schedule is set
  hasAutoScalingAction: boolean; // Indicates if alarm triggers auto-scaling
}

/**
 * Retrieves and evaluates the conditions for a given alarm based on its tags and actions
 * @param alarm - The CloudWatch metric alarm to evaluate
 * @returns Promise<ReAlarmConditions> - Object containing the evaluated conditions
 */
async function getAlarmConditions(
  alarm: MetricAlarm,
): Promise<ReAlarmConditions> {
  const tagsResponse = await cloudwatch.send(
    new ListTagsForResourceCommand({ResourceARN: alarm.AlarmArn as string}),
  );

  return {
    // Check if alarm has been explicitly disabled via tags
    reAlarmDisabled:
      tagsResponse.Tags?.some(
        (tag) =>
          tag.Key === 'autoalarm:re-alarm-enabled' && tag.Value === 'false',
      ) ?? false,
    // Check if alarm has custom re-alarm schedule
    reAlarmOverrideTag:
      tagsResponse.Tags?.some(
        (tag) =>
          tag.Key === 'autoalarm:re-alarm-minutes' && !isNaN(Number(tag.Value)),
      ) ?? false,
    // Check if alarm triggers auto-scaling actions
    hasAutoScalingAction: (alarm.AlarmActions || []).some((action) =>
      action.includes('autoscaling'),
    ),
  };
}

/**
 * Logs the status of alarm processing with relevant details
 * @param functionName - Name of the calling function for context
 * @param alarm - The alarm being processed
 * @param conditions - The conditions that were evaluated
 * @param status - Whether the alarm was added for processing or skipped
 */
async function logAlarmStatus(
  functionName: string,
  alarm: MetricAlarm,
  conditions: ReAlarmConditions,
  status: 'added' | 'skipped',
) {
  const baseLog = log
    .info()
    .str('function', functionName)
    .str('alarmName', alarm.AlarmName as string)
    .str('reAlarmDisabled', String(conditions.reAlarmDisabled))
    .str(
      'reAlarmOverrideTag',
      conditions.reAlarmOverrideTag
        ? 'ReAlarm Default Schedule is Overriden'
        : 'false',
    )
    .str('actions', (alarm.AlarmActions || []).join(', '));

  baseLog.msg(
    status === 'added'
      ? `Adding alarm: ${alarm.AlarmName} to list of alarms to be reset`
      : 'Skipping alarm due to tag conditions or AutoScaling Actions',
  );
}

/**
 * Determines if an alarm should be processed based on its conditions
 * @param alarm - The alarm to validate
 * @param isOverride - Whether we're checking for override-specific processing
 * @returns Promise<boolean> - Whether the alarm should be processed
 */
async function isValidAlarm(
  alarm: MetricAlarm,
  isOverride: boolean,
): Promise<boolean> {
  const conditions = await getAlarmConditions(alarm);
  return (
    !conditions.reAlarmDisabled &&
    !conditions.hasAutoScalingAction &&
    conditions.reAlarmOverrideTag === isOverride
  );
}

/**
 * Retrieves and validates a specific alarm for override processing
 * @param alarmName - Name of the alarm to retrieve
 * @returns Promise<MetricAlarm[]> - Array containing the validated alarm or empty if invalid
 */
async function getOverriddenAlarm(alarmName: string): Promise<MetricAlarm[]> {
  try {
    const response = await cloudwatch.send(
      new DescribeAlarmsCommand({AlarmNames: [alarmName]}),
    );

    if (!response.MetricAlarms?.length) {
      log
        .info()
        .str('function', 'getOverriddenAlarm')
        .str('alarmName', alarmName)
        .msg('Alarm not found');
      return [];
    }

    const alarm = response.MetricAlarms[0];
    const isValid = await isValidAlarm(alarm, true);
    const conditions = await getAlarmConditions(alarm);

    await logAlarmStatus(
      'getOverriddenAlarm',
      alarm,
      conditions,
      isValid ? 'added' : 'skipped',
    );
    return isValid ? [alarm] : [];
  } catch (error) {
    log
      .error()
      .str('alarmName', alarmName)
      .msg(`Failed to get alarm: ${error}`);
    throw error;
  }
}

/**
 * Retrieves and validates all alarms that should be processed on the standard schedule
 * @returns Promise<MetricAlarm[]> - Array of valid alarms to be processed
 */
async function getStandardReAlarmScheduledAlarms(): Promise<MetricAlarm[]> {
  const validAlarms: MetricAlarm[] = [];
  const paginator = paginateDescribeAlarms(
    {client: cloudwatch, pageSize: 100},
    {},
  );

  for await (const page of paginator) {
    if (!page.MetricAlarms?.length) continue;

    await Promise.all(
      page.MetricAlarms.map(async (alarm) => {
        const isValid = await isValidAlarm(alarm, false);
        const conditions = await getAlarmConditions(alarm);
        await logAlarmStatus(
          'getStandardReAlarmScheduledAlarms',
          alarm,
          conditions,
          isValid ? 'added' : 'skipped',
        );
        if (isValid) validAlarms.push(alarm);
      }),
    );
  }

  return validAlarms;
}

/**
 * Resets the state of a given alarm to 'OK'
 * @param alarmName - Name of the alarm to reset
 * @throws Error if the reset operation fails
 */
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
      .str('function', 'resetAlarmState')
      .str('alarmName', alarmName)
      .msg(`Failed to reset alarm: ${alarmName}. Error: ${error}`);
    throw error;
  }
}

/**
 * Main function to process and reset alarms based on configuration
 * @param reAlarmOverride - Whether to process a specific override alarm
 * @param overrideAlarmName - Name of the specific alarm to process (required if reAlarmOverride is true)
 */
async function checkAndResetAlarms(
  reAlarmOverride: boolean,
  overrideAlarmName?: string,
): Promise<void> {
  if (reAlarmOverride && !overrideAlarmName) {
    throw new Error(
      'overrideAlarmName is required when reAlarmOverride is true',
    );
  }

  const alarms = reAlarmOverride
    ? await getOverriddenAlarm(overrideAlarmName!)
    : await getStandardReAlarmScheduledAlarms();

  if (!alarms.length) {
    log.info().str('function', 'checkAndResetAlarms').msg('No alarms to reset');
    return;
  }

  await Promise.all(
    alarms.map((alarm) => resetAlarmState(alarm.AlarmName as string)),
  );
}


export const handler: Handler = async (event: {
  'reAlarmOverride-AlarmName'?: string;
}): Promise<void> => {
  log.trace().unknown('event', event).msg('Received event');
  // Check if the event contains an override alarm name. If not, return false and undefined to checkAndResetAlarms. Otherwise, true and the alarm name.
  await checkAndResetAlarms(
    !!event['reAlarmOverride-AlarmName'],
    event['reAlarmOverride-AlarmName'],
  );
};
