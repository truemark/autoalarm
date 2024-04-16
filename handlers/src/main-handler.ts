import {
  EC2Client,
  DescribeTagsCommand,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  PutMetricAlarmCommand,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {Handler} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {Logger} from '@nr1e/logging';

const ec2Client = new EC2Client({});
const cloudWatchClient = new CloudWatchClient({});

interface AlarmProps {
  threshold: number;
  period: number;
  evaluationPeriods: number;
}

interface Tag {
  [key: string]: string;
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

async function needsUpdate(
  log: Logger,
  alarmName: string,
  newProps: AlarmProps
): Promise<boolean> {
  try {
    const existingAlarm = await cloudWatchClient.send(
      new DescribeAlarmsCommand({AlarmNames: [alarmName]})
    );

    if (existingAlarm.MetricAlarms && existingAlarm.MetricAlarms.length > 0) {
      const existingProps = existingAlarm.MetricAlarms[0];

      if (
        existingProps.Threshold !== newProps.threshold ||
        existingProps.EvaluationPeriods !== newProps.evaluationPeriods ||
        existingProps.Period !== newProps.period
      ) {
        log.info().str('alarmName', alarmName).msg('Alarm needs update');
        return true;
      }
    } else {
      log.info().str('alarmName', alarmName).msg('Alarm does not exist');
      return true;
    }

    log.info().str('alarmName', alarmName).msg('Alarm does not need update');
    return false;
  } catch (e) {
    log.error().err(e).msg('Failed to determine if alarm needs update:');
    return false;
  }
}

async function manageCPUUsageAlarmForInstance(
  log: Logger,
  instanceId: string,
  tags: Tag,
  type: 'Critical' | 'Warning'
): Promise<void> {
  const baseAlarmName = `AutoAlarm-EC2-${instanceId}-${type}CPUUtilization`;
  const thresholdKey = `autoalarm:cpu-percent-above-${type.toLowerCase()}`;
  const defaultThreshold = type === 'Critical' ? 99 : 97;

  const alarmProps = {
    threshold: defaultThreshold,
    period: 60,
    evaluationPeriods: 5,
  };

  try {
    if (tags[thresholdKey]) {
      const parsedThreshold = parseFloat(tags[thresholdKey]);
      if (!isNaN(parsedThreshold)) {
        alarmProps.threshold = parsedThreshold;
      } else {
        log
          .warn()
          .str('tag', thresholdKey)
          .str('value', tags[thresholdKey])
          .msg('Invalid threshold value in tag, using default');
      }
    }

    if (tags['autoalarm:cpu-percent-duration-time']) {
      let parsedPeriod = parseInt(
        tags['autoalarm:cpu-percent-duration-time'],
        10
      );
      if (!isNaN(parsedPeriod)) {
        // Validate and adjust the period value to align with CloudWatch's requirements
        if (parsedPeriod < 10) {
          parsedPeriod = 10;
          log
            .info()
            .str('tag', 'autoalarm:cpu-percent-duration-time')
            .str('value', tags['autoalarm:cpu-percent-duration-time'])
            .num('period', parsedPeriod)
            .msg(
              'Period value less than 10 is not allowed, must be 10, 30, or multiple of 60. Using default value of 10'
            );
        } else if (parsedPeriod < 30) {
          parsedPeriod = 30;
          log
            .info()
            .str('tag', 'autoalarm:cpu-percent-duration-time')
            .str('value', tags['autoalarm:cpu-percent-duration-time'])
            .num('period', parsedPeriod)
            .msg(
              'Period value not 10 or 30 is not allowed, must be 10, 30, or multiple of 60. Since value is less ' +
                'than 30 but more than 10, Using default value of 30'
            );
        } else {
          parsedPeriod = Math.ceil(parsedPeriod / 60) * 60;
          log
            .info()
            .str('tag', 'autoalarm:cpu-percent-duration-time')
            .str('value', tags['autoalarm:cpu-percent-duration-time'])
            .num('period', parsedPeriod)
            .msg(
              'Period value that is not 10 or 30 must be multiple of 60. Adjusted to nearest multiple of 60'
            );
        }
        alarmProps.period = parsedPeriod;
      } else {
        log
          .warn()
          .str('tag', 'autoalarm:cpu-percent-duration-time')
          .str('value', tags['autoalarm:cpu-percent-duration-time'])
          .msg('Invalid duration value in tag, using default');
      }
    }

    if (tags['autoalarm:cpu-percent-duration-periods']) {
      const parsedEvaluationPeriods = parseInt(
        tags['autoalarm:cpu-percent-duration-periods'],
        10
      );
      if (!isNaN(parsedEvaluationPeriods)) {
        alarmProps.evaluationPeriods = parsedEvaluationPeriods;
      } else {
        log
          .warn()
          .str('tag', 'autoalarm:cpu-percent-duration-periods')
          .str('value', tags['autoalarm:cpu-percent-duration-periods'])
          .msg('Invalid evaluation periods value in tag, using default');
      }
    }
  } catch (error) {
    log
      .error()
      .err(error)
      .msg('Error parsing tag values, using default values');
  }

  const alarmExists = await doesAlarmExist(baseAlarmName);

  if (
    !alarmExists ||
    (alarmExists && (await needsUpdate(log, baseAlarmName, alarmProps)))
  ) {
    try {
      await cloudWatchClient.send(
        new PutMetricAlarmCommand({
          AlarmName: baseAlarmName,
          ComparisonOperator: 'GreaterThanThreshold',
          EvaluationPeriods: alarmProps.evaluationPeriods,
          MetricName: 'CPUUtilization',
          Namespace: 'AWS/EC2',
          Period: alarmProps.period,
          Statistic: 'Average',
          Threshold: alarmProps.threshold,
          ActionsEnabled: false,
          Dimensions: [{Name: 'InstanceId', Value: instanceId}],
        })
      );
      log
        .info()
        .str('alarmName', baseAlarmName)
        .str('instanceId', instanceId)
        .num('threshold', alarmProps.threshold)
        .num('period', alarmProps.period)
        .num('evaluationPeriods', alarmProps.evaluationPeriods)
        .msg('Alarm configured');
    } catch (e) {
      log
        .error()
        .err(e)
        .str('alarmName', baseAlarmName)
        .str('instanceId', instanceId)
        .msg('Failed to create or update alarm due to an error');
    }
  } else {
    log
      .info()
      .str('alarmName', baseAlarmName)
      .str('instanceId', instanceId)
      .msg('CPU usage alarm is already up-to-date');
  }
}

async function createStatusAlarmForInstance(
  log: Logger,
  instanceId: string
): Promise<void> {
  const alarmName = `AutoAlarm-EC2-${instanceId}-StatusCheckFailed`;
  const alarmExists = await doesAlarmExist(alarmName);
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
      .msg('Alarm already exists for instance');
  }
}

async function fetchInstanceTags(
  log: Logger,
  instanceId: string
): Promise<{[key: string]: string}> {
  try {
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
  } catch (error) {
    log
      .error()
      .err(error)
      .str('instanceId', instanceId)
      .msg('Error fetching instance tags');
    return {};
  }
}

export const handler: Handler = async (event: any): Promise<void> => {
  await logging.initialize({
    svc: 'AutoAlarm',
    name: 'main-handler',
    level: 'trace',
  });

  const log = logging.getRootLogger();

  log.trace().unknown('event', event).msg('Received event');

  try {
    if (event.source === 'aws.ec2') {
      const instanceId = event.detail['instance-id'];
      const state = event.detail.state;
      log
        .info()
        .str('instanceId', instanceId)
        .str('state', state)
        .msg('Processing EC2 event');

      // Check if the instance is running and create alarms for cpu usage which should be done by default for every instance
      if (state === 'running') {
        const tags = await fetchInstanceTags(log, instanceId);
        log.info().str('tags', JSON.stringify(tags)).msg('Fetched tags');
        await manageCPUUsageAlarmForInstance(log, instanceId, tags, 'Critical');
        await manageCPUUsageAlarmForInstance(log, instanceId, tags, 'Warning');

        // Check if the instance has the "autoalarm:disabled" tag set to "true" and skip creating status check alarm
        if (tags['autoalarm:disabled'] === 'true') {
          log.info().msg('autoalarm:disabled=true. Skipping alarm creation');
          // Check if the instance has the "autoalarm:disabled" tag set to "false" and create status check alarm
        } else if (tags['autoalarm:disabled'] === 'false') {
          await createStatusAlarmForInstance(log, instanceId);
          log.info().msg('autoalarm:disabled=false');
        }
        // If the instance is terminated, delete all alarms
      } else if (state === 'terminated') {
        await deleteAlarm(log, instanceId, 'WarningCPUUtilization');
        await deleteAlarm(log, instanceId, 'CriticalCPUUtilization');
        await deleteAlarm(log, instanceId, 'StatusCheckFailed');
      }
    } else if (event.source === 'aws.tag') {
      const resourceId = event.resources[0].split('/').pop();
      log.info().str('resourceId', resourceId).msg('Processing tag event');

      try {
        // This event bridge rule sometimes sends delayed tag signals. Here we are checking if those instances exist.
        const describeInstancesResponse = await ec2Client.send(
          new DescribeInstancesCommand({
            InstanceIds: [resourceId],
          })
        );

        const instance =
          describeInstancesResponse.Reservations?.[0]?.Instances?.[0];

        if (instance && instance.State?.Name === 'running') {
          const tags = await fetchInstanceTags(log, resourceId);
          log
            .info()
            .str('resource:', resourceId)
            .str('tags', JSON.stringify(tags))
            .msg('Fetched tags');

          // Create default alarms for CPU usage or update thresholds if they exist in tag updates
          await manageCPUUsageAlarmForInstance(
            log,
            resourceId,
            tags,
            'Critical'
          );
          await manageCPUUsageAlarmForInstance(
            log,
            resourceId,
            tags,
            'Warning'
          );

          // Create or delete status check alarm based on the value of the "autoalarm:disabled" tag
          if (tags['autoalarm:disabled'] === 'false') {
            await createStatusAlarmForInstance(log, resourceId);
          } else if (tags['autoalarm:disabled'] === 'true') {
            await deleteAlarm(log, resourceId, 'StatusCheckFailed');
            // If the tag exists but has an unexpected value, log the value and check for the alarm and create if it does not exist
          } else if ('autoalarm:disabled' in tags) {
            log
              .info()
              .str('resource:', resourceId)
              .str('autoalarm:disabled', tags['autoalarm:disabled'])
              .msg(
                'autoalarm:disabled tag exists but has unexpected value. checking for alarm and creating if it does not exist'
              );
            await createStatusAlarmForInstance(log, resourceId);
            // If the tag is not found, check for the alarm and delete if it exists
          } else {
            log
              .info()
              .msg(
                'autoalarm:disabled tag not found. checking for alarm and deleting if exists'
              );
            await deleteAlarm(log, resourceId, 'StatusCheckFailed');
          }
        } else {
          log
            .info()
            .str('resourceId', resourceId)
            .msg(
              'Instance has since been deleted or terminated. Skipping alarm management.'
            );
        }
      } catch (error) {
        log
          .error()
          .err(error)
          .str('resourceId', resourceId)
          .msg('Error describing instance');
      }
    }
  } catch (e) {
    log.error().err(e).msg('Error processing event');
  }
};
