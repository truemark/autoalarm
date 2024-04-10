import {EC2Client, DescribeTagsCommand} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  PutMetricAlarmCommand,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {Handler, Context} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {Logger} from '@nr1e/logging';

const ec2Client = new EC2Client({});
const cloudWatchClient = new CloudWatchClient({});

async function createCPUThresholdAlarm(
  alarmName: string,
  instanceId: string,
  threshold: number,
  duration: number,
  evaluationPeriods: number
): Promise<void> {
  await cloudWatchClient.send(
    new PutMetricAlarmCommand({
      AlarmName: alarmName,
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: evaluationPeriods,
      MetricName: 'CPUUtilization',
      Namespace: 'AWS/EC2',
      Period: duration,
      Statistic: 'Average',
      Threshold: threshold,
      ActionsEnabled: false,
      Dimensions: [{Name: 'InstanceId', Value: instanceId}],
    })
  );
}

async function doesAlarmExist(alarmName: string): Promise<boolean> {
  const response = await cloudWatchClient.send(
    new DescribeAlarmsCommand({AlarmNames: [alarmName]})
  );
  return (response.MetricAlarms?.length ?? 0) > 0;
}

async function deleteAlarm(
  log: Logger,
  instanceId: string,
  check: string
): Promise<void> {
  const alarmName = `AutoAlarm-EC2-${instanceId}-${check}`;
  const alarmExists = await doesAlarmExist(alarmName);
  if (alarmExists) {
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Attempting to delete alarm');
    await cloudWatchClient.send(
      new DeleteAlarmsCommand({AlarmNames: [alarmName]})
    );
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Deleted alarm');
  } else {
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Alarm does not exist for instance');
  }
}

async function CriticalCPUUsageAlarmForInstance(
  log: Logger,
  instanceId: string,
  tags: {[key: string]: string}
): Promise<void> {
  const alarmName = `AutoAlarm-EC2-${instanceId}-CriticalCPUUtilization`;
  const alarmExists = await doesAlarmExist(alarmName);
  let threshold = 99; // Default threshold
  let duration = 60; // Default duration (in seconds)
  let evaluationPeriods = 5; // Default evaluation periods

  // Check for the "autoalarm:cpu-percent-above-critical" tag
  const thresholdTag = tags['autoalarm:cpu-percent-above-critical'];
  if (thresholdTag) {
    log
      .info()
      .str('tag', 'autoalarm:cpu-percent-above-critical')
      .str('value', thresholdTag)
      .msg(
        'Found threshold value in tag: autoalarm:cpu-percent-above-critical'
      );
    const parsedThreshold = parseFloat(thresholdTag);
    if (!isNaN(parsedThreshold)) {
      threshold = parsedThreshold;
    } else {
      log
        .warn()
        .str('tag', 'autoalarm:cpu-percent-above-critical')
        .str('value', thresholdTag)
        .msg('Invalid threshold value in tag, using default');
    }
  }

  // Check for the "autoalarm:cpu-percent-duration-time" tag
  const durationTag = tags['autoalarm:cpu-percent-duration-time'];
  if (durationTag) {
    log
      .info()
      .str('tag', 'autoalarm:cpu-percent-duration-time')
      .str('value', durationTag)
      .msg('Found duration value in tag: autoalarm:cpu-percent-duration-time');
    const parsedDuration = parseInt(durationTag, 10);
    if (!isNaN(parsedDuration)) {
      duration = parsedDuration;
    } else {
      log
        .warn()
        .str('tag', 'autoalarm:cpu-percent-duration-time')
        .str('value', durationTag)
        .msg('Invalid duration value in tag, using default');
    }
  }

  // Check for the "autoalarm:cpu-percent-duration-periods" tag
  const evaluationPeriodsTag = tags['autoalarm:cpu-percent-duration-periods'];
  if (evaluationPeriodsTag) {
    log
      .info()
      .str('tag', 'autoalarm:cpu-percent-duration-periods')
      .str('value', evaluationPeriodsTag)
      .msg(
        'Found evaluation periods value in tag: autoalarm:cpu-percent-duration-periods'
      );
    const parsedEvaluationPeriods = parseInt(evaluationPeriodsTag, 10);
    if (!isNaN(parsedEvaluationPeriods)) {
      evaluationPeriods = parsedEvaluationPeriods;
    } else {
      log
        .warn()
        .str('tag', 'autoalarm:cpu-percent-duration-periods')
        .str('value', evaluationPeriodsTag)
        .msg('Invalid evaluation periods value in tag, using default');
    }
  }

  if (alarmExists) {
    // Get the existing alarm's threshold value
    const existingAlarm = await cloudWatchClient.send(
      new DescribeAlarmsCommand({AlarmNames: [alarmName]})
    );
    const existingThreshold = existingAlarm.MetricAlarms?.[0].Threshold;

    if (existingThreshold !== threshold) {
      // Update the existing alarm's threshold value if it's different
      await createCPUThresholdAlarm(
        alarmName,
        instanceId,
        threshold,
        duration,
        evaluationPeriods
      );
      log
        .info()
        .str('alarmName', alarmName)
        .str('instanceId', instanceId)
        .num('threshold', threshold)
        .num('duration', duration)
        .num('evaluationPeriods', evaluationPeriods)
        .msg('Updated Critical CPU usage alarm');
    } else {
      log
        .info()
        .str('alarmName', alarmName)
        .str('instanceId', instanceId)
        .num('threshold', threshold)
        .num('duration', duration)
        .num('evaluationPeriods', evaluationPeriods)
        .msg('Critical CPU usage alarm is already up-to-date');
    }
  } else {
    // Create a new alarm
    await createCPUThresholdAlarm(
      alarmName,
      instanceId,
      threshold,
      duration,
      evaluationPeriods
    );
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .num('threshold', threshold)
      .num('duration', duration)
      .num('evaluationPeriods', evaluationPeriods)
      .msg('Created Critical CPU usage alarm');
  }
}

async function warningCPUUsageAlarmForInstance(
  log: Logger,
  instanceId: string,
  tags: {[key: string]: string}
): Promise<void> {
  const alarmName = `AutoAlarm-EC2-${instanceId}-WarningCPUUtilization`;
  const alarmExists = await doesAlarmExist(alarmName);
  let threshold = 97; // Default threshold
  let duration = 60; // Default duration (in seconds)
  let evaluationPeriods = 5; // Default evaluation periods

  // Check for the "autoalarm:cpu-percent-above-warning" tag
  const thresholdTag = tags['autoalarm:cpu-percent-above-warning'];
  if (thresholdTag) {
    log
      .info()
      .str('tag', 'autoalarm:cpu-percent-above-warning')
      .str('value', thresholdTag)
      .msg('Found threshold value in tag: autoalarm:cpu-percent-above-warning');
    const parsedThreshold = parseFloat(thresholdTag);
    if (!isNaN(parsedThreshold)) {
      threshold = parsedThreshold;
    } else {
      log
        .warn()
        .str('tag', 'autoalarm:cpu-percent-above-warning')
        .str('value', thresholdTag)
        .msg('Invalid threshold value in tag, using default');
    }
  }

  // Check for the "autoalarm:cpu-percent-duration-time" tag
  const durationTag = tags['autoalarm:cpu-percent-duration-time'];
  if (durationTag) {
    log
      .info()
      .str('tag', 'autoalarm:cpu-percent-duration-time')
      .str('value', durationTag)
      .msg('Found duration value in tag: autoalarm:cpu-percent-duration-time');
    const parsedDuration = parseInt(durationTag, 10);
    if (!isNaN(parsedDuration)) {
      duration = parsedDuration;
    } else {
      log
        .warn()
        .str('tag', 'autoalarm:cpu-percent-duration-time')
        .str('value', durationTag)
        .msg('Invalid duration value in tag, using default');
    }
  }

  // Check for the "autoalarm:cpu-percent-duration-periods" tag
  const evaluationPeriodsTag = tags['autoalarm:cpu-percent-duration-periods'];
  if (evaluationPeriodsTag) {
    log
      .info()
      .str('tag', 'autoalarm:cpu-percent-duration-periods')
      .str('value', evaluationPeriodsTag)
      .msg(
        'Found evaluation periods value in tag: autoalarm:cpu-percent-duration-periods'
      );
    const parsedEvaluationPeriods = parseInt(evaluationPeriodsTag, 10);
    if (!isNaN(parsedEvaluationPeriods)) {
      evaluationPeriods = parsedEvaluationPeriods;
    } else {
      log
        .warn()
        .str('tag', 'autoalarm:cpu-percent-duration-periods')
        .str('value', evaluationPeriodsTag)
        .msg('Invalid evaluation periods value in tag, using default');
    }
  }

  if (alarmExists) {
    // Get the existing alarm's threshold value
    const existingAlarm = await cloudWatchClient.send(
      new DescribeAlarmsCommand({AlarmNames: [alarmName]})
    );
    const existingThreshold = existingAlarm.MetricAlarms?.[0].Threshold;

    if (existingThreshold !== threshold) {
      // Update the existing alarm's threshold value if it's different
      await createCPUThresholdAlarm(
        alarmName,
        instanceId,
        threshold,
        duration,
        evaluationPeriods
      );
      log
        .info()
        .str('alarmName', alarmName)
        .str('instanceId', instanceId)
        .num('threshold', threshold)
        .num('duration', duration)
        .num('evaluationPeriods', evaluationPeriods)
        .msg('Updated Warning CPU usage alarm');
    } else {
      log
        .info()
        .str('alarmName', alarmName)
        .str('instanceId', instanceId)
        .num('threshold', threshold)
        .num('duration', duration)
        .num('evaluationPeriods', evaluationPeriods)
        .msg('Warning CPU usage alarm is already up-to-date');
    }
  } else {
    // Create a new alarm
    await createCPUThresholdAlarm(
      alarmName,
      instanceId,
      threshold,
      duration,
      evaluationPeriods
    );
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .num('threshold', threshold)
      .num('duration', duration)
      .num('evaluationPeriods', evaluationPeriods)
      .msg('Created Warning CPU usage alarm');
  }
}

async function createStatusAlarmForInstance(
  log: Logger,
  instanceId: string
): Promise<void> {
  const alarmName = `AutoAlarm-EC2-${instanceId}-StatusCheckFailed`;
  const alarmExists = await doesAlarmExist(instanceId);
  if (!alarmExists) {
    await cloudWatchClient.send(
      new PutMetricAlarmCommand({
        AlarmName: alarmName,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
        MetricName: 'StatusCheckFailed',
        Namespace: 'AWS/EC2',
        Period: 300,
        Statistic: 'Average',
        Threshold: 0,
        ActionsEnabled: false,
        Dimensions: [{Name: 'InstanceId', Value: instanceId}],
      })
    );
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Created alarm');
  } else {
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Alarm  already exists for instance');
  }
}

async function fetchInstanceTags(
  instanceId: string
): Promise<{[key: string]: string}> {
  const response = await ec2Client.send(
    new DescribeTagsCommand({
      Filters: [{Name: 'resource-id', Values: [instanceId]}],
    })
  );
  const tags: {[key: string]: string} = {};
  response.Tags?.forEach(tag => {
    if (tag.Key && tag.Value) {
      tags[tag.Key] = tag.Value;
    }
  });
  return tags;
}

export const handler: Handler = async (
  event: any,
  context: Context
): Promise<void> => {
  const log = await logging.initialize({
    svc: 'AutoAlarm',
    name: 'main-handler',
    level: 'trace',
  });
  const sublog = logging.getLogger('ec2-tag-autoalarm', log);
  sublog.trace().unknown('context', context).msg('Received context');

  try {
    if (event.source === 'aws.ec2') {
      const instanceId = event.detail['instance-id'];
      const state = event.detail.state;
      sublog
        .info()
        .str('instanceId', instanceId)
        .str('state', state)
        .msg('Processing EC2 event');

      // Check if the instance is running and create alarms for cpu usage which should be done by default for every instance
      if (state === 'running') {
        const tags = await fetchInstanceTags(instanceId);
        sublog.info().str('tags', JSON.stringify(tags)).msg('Fetched tags');
        await warningCPUUsageAlarmForInstance(sublog, instanceId, tags);
        await CriticalCPUUsageAlarmForInstance(sublog, instanceId, tags);

        // Check if the instance has the "autoalarm:disabled" tag set to "true" and skip creating status check alarm
        if (tags['autoalarm:disabled'] === 'true') {
          sublog.info().msg('autoalarm:disabled=true. Skipping alarm creation');
          // Check if the instance has the "autoalarm:disabled" tag set to "false" and create status check alarm
        } else if (tags['autoalarm:disabled'] === 'false') {
          await createStatusAlarmForInstance(sublog, instanceId);
          sublog.info().msg('autoalarm:disabled=false');
        }
        // If the instance is terminated, delete all alarms
      } else if (state === 'terminated') {
        await deleteAlarm(sublog, instanceId, 'WarningCPUUtilization');
        await deleteAlarm(sublog, instanceId, 'CriticalCPUUtilization');
        await deleteAlarm(sublog, instanceId, 'StatusCheckFailed');
      }
    } else if (event.source === 'aws.tag') {
      const resourceId = event.resources[0].split('/').pop();
      sublog.info().str('resourceId', resourceId).msg('Processing tag event');

      const tags = await fetchInstanceTags(resourceId);
      sublog
        .info()
        .str('resource:', resourceId)
        .str('tags', JSON.stringify(tags))
        .msg('Fetched tags');

      // Create default alarms for CPU usage or update thresholds if they exist in tag updates
      await warningCPUUsageAlarmForInstance(sublog, resourceId, tags);
      await CriticalCPUUsageAlarmForInstance(sublog, resourceId, tags);

      // Create or delete status check alarm based on the value of the "autoalarm:disabled" tag
      if (tags['autoalarm:disabled'] === 'false') {
        await createStatusAlarmForInstance(sublog, resourceId);
      } else if (tags['autoalarm:disabled'] === 'true') {
        await deleteAlarm(sublog, resourceId, 'StatusCheckFailed');
      }
    }
  } catch (e) {
    sublog.error().err(e).msg('Error processing event');
  }
};
