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
            .msg(
              'Period value less than 10 is not allowed, must be 10, 30, or multiple of 60. Using default value of 10'
            );
        } else if (parsedPeriod < 30) {
          parsedPeriod = 30;
          log
            .info()
            .str('tag', 'autoalarm:cpu-percent-duration-time')
            .str('value', tags['autoalarm:cpu-percent-duration-time'])
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
    await createOrUpdateAlarm(log, baseAlarmName, instanceId, alarmProps);
  } else {
    log
      .info()
      .str('alarmName', baseAlarmName)
      .str('instanceId', instanceId)
      .msg('CPU usage alarm is already up-to-date');
  }
}

async function createOrUpdateAlarm(
  log: Logger,
  alarmName: string,
  instanceId: string,
  props: AlarmProps
) {
  try {
    await cloudWatchClient.send(
      new PutMetricAlarmCommand({
        AlarmName: alarmName,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: props.evaluationPeriods,
        MetricName: 'CPUUtilization',
        Namespace: 'AWS/EC2',
        Period: props.period,
        Statistic: 'Average',
        Threshold: props.threshold,
        ActionsEnabled: false,
        Dimensions: [{Name: 'InstanceId', Value: instanceId}],
      })
    );
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .num('threshold', props.threshold)
      .msg('Alarm configured');
  } catch (e) {
    log
      .error()
      .err(e)
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Failed to configure alarm due to an error');
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
        await manageCPUUsageAlarmForInstance(
          sublog,
          instanceId,
          tags,
          'Critical'
        );
        await manageCPUUsageAlarmForInstance(
          sublog,
          instanceId,
          tags,
          'Warning'
        );

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
      await manageCPUUsageAlarmForInstance(
        sublog,
        resourceId,
        tags,
        'Critical'
      );
      await manageCPUUsageAlarmForInstance(sublog, resourceId, tags, 'Warning');

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
