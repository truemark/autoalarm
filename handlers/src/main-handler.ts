import {
  DescribeInstancesCommand,
  DescribeTagsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
  PutMetricAlarmCommand,
} from '@aws-sdk/client-cloudwatch';
import {Handler} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {AlarmClassification, ValidInstanceState} from './enums';
import {AlarmProps, Tag} from './types';

let log: ReturnType<typeof logging.getRootLogger>;
const ec2Client = new EC2Client({});
const cloudWatchClient = new CloudWatchClient({});

async function loggingSetup() {
  await logging.initialize({
    svc: 'AutoAlarm',
    name: 'main-handler',
    level: 'trace',
  });
  // Initialize log after logging has been set up
  log = logging.getRootLogger();
}

async function doesAlarmExist(alarmName: string): Promise<boolean> {
  const response = await cloudWatchClient.send(
    new DescribeAlarmsCommand({AlarmNames: [alarmName]})
  );
  return (response.MetricAlarms?.length ?? 0) > 0;
}

async function deleteAlarm(instanceId: string, check: string): Promise<void> {
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
        Number(existingProps.Threshold) !== newProps.threshold ||
        Number(existingProps.EvaluationPeriods) !==
          newProps.evaluationPeriods ||
        Number(existingProps.Period) !== newProps.period
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

async function createOrUpdateAlarm(
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
        MetricName: props.metricName,
        Namespace: props.namespace,
        Period: props.period,
        Statistic: 'Average',
        Threshold: props.threshold,
        ActionsEnabled: false,
        Dimensions: props.dimensions,
      })
    );
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .num('threshold', props.threshold)
      .num('period', props.period)
      .num('evaluationPeriods', props.evaluationPeriods)
      .msg('Alarm configured');
  } catch (e) {
    log
      .error()
      .err(e)
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Failed to create or update alarm due to an error');
  }
}

function configureAlarmPropsFromTags(
  alarmProps: AlarmProps,
  tags: Tag,
  thresholdKey: string,
  durationTimeKey: string,
  durationPeriodsKey: string
): void {
  // Adjust threshold based on tags
  if (tags[thresholdKey]) {
    const parsedThreshold = parseFloat(tags[thresholdKey]);
    if (!isNaN(parsedThreshold)) {
      alarmProps.threshold = parsedThreshold;
      log
        .info()
        .str('tag', thresholdKey)
        .num('threshold', parsedThreshold)
        .msg('Adjusted threshold based on tag');
    } else {
      log
        .warn()
        .str('tag', thresholdKey)
        .str('value', tags[thresholdKey])
        .msg('Invalid threshold value in tag, using default');
    }
  }

  // Adjust period based on tags
  if (tags[durationTimeKey]) {
    let parsedPeriod = parseInt(tags[durationTimeKey], 10);
    if (!isNaN(parsedPeriod)) {
      if (parsedPeriod < 10) {
        parsedPeriod = 10;
        log
          .info()
          .str('tag', durationTimeKey)
          .num('period', parsedPeriod)
          .msg(
            'Period value less than 10 is not allowed, must be 10. Using default value of 10'
          );
      } else if (parsedPeriod < 30) {
        parsedPeriod = 30;
        log
          .info()
          .str('tag', durationTimeKey)
          .num('period', parsedPeriod)
          .msg(
            'Period value less than 30 and not 10 is adjusted to 30. Using default value of 30'
          );
      } else {
        parsedPeriod = Math.ceil(parsedPeriod / 60) * 60;
        log
          .info()
          .str('tag', durationTimeKey)
          .num('period', parsedPeriod)
          .msg(
            'Period value not 10 or 30 must be multiple of 60. Adjusted to nearest multiple of 60'
          );
      }
      alarmProps.period = parsedPeriod;
    } else {
      log
        .warn()
        .str('tag', durationTimeKey)
        .str('value', tags[durationTimeKey])
        .msg('Invalid period value in tag, using default 60 seconds');
    }
  }

  // Adjust evaluation periods based on tags
  if (tags[durationPeriodsKey]) {
    const parsedEvaluationPeriods = parseInt(tags[durationPeriodsKey], 10);
    if (!isNaN(parsedEvaluationPeriods)) {
      alarmProps.evaluationPeriods = parsedEvaluationPeriods;
      log
        .info()
        .str('tag', durationPeriodsKey)
        .num('evaluationPeriods', parsedEvaluationPeriods)
        .msg('Adjusted evaluation periods based on tag');
    } else {
      log
        .warn()
        .str('tag', durationPeriodsKey)
        .str('value', tags[durationPeriodsKey])
        .msg('Invalid evaluation periods value in tag, using default 5');
    }
  }
}

async function manageCPUUsageAlarmForInstance(
  instanceId: string,
  tags: Tag,
  type: AlarmClassification
): Promise<void> {
  const baseAlarmName = `AutoAlarm-EC2-${instanceId}-${type}CPUUtilization`;
  const thresholdKey = `autoalarm:cpu-percent-above-${type.toLowerCase()}`;
  const durationTimeKey = 'autoalarm:cpu-percent-duration-time';
  const durationPeriodsKey = 'autoalarm:cpu-percent-duration-periods';
  const defaultThreshold = type === 'Critical' ? 99 : 97;

  const alarmProps: AlarmProps = {
    threshold: defaultThreshold,
    period: 60,
    namespace: 'AWS/EC2',
    evaluationPeriods: 5,
    metricName: 'CPUUtilization',
    dimensions: [{Name: 'InstanceId', Value: instanceId}],
  };

  try {
    configureAlarmPropsFromTags(
      alarmProps,
      tags,
      thresholdKey,
      durationTimeKey,
      durationPeriodsKey
    );
  } catch (e) {
    log.error().err(e).msg('Error configuring alarm props from tags');
    throw new Error('Error configuring alarm props from tags');
  }

  const alarmExists = await doesAlarmExist(baseAlarmName);

  if (
    !alarmExists ||
    (alarmExists && (await needsUpdate(baseAlarmName, alarmProps)))
  ) {
    await createOrUpdateAlarm(baseAlarmName, instanceId, alarmProps);
    log
      .info()
      .str('alarmName', baseAlarmName)
      .str('instanceId', instanceId)
      .msg('CPU usage alarm configured or updated.');
  } else {
    log
      .info()
      .str('alarmName', baseAlarmName)
      .str('instanceId', instanceId)
      .msg('CPU usage alarm is already up-to-date');
  }
}

async function manageStorageAlarmForInstance(
  instanceId: string,
  platform: string,
  tags: Tag,
  type: AlarmClassification
): Promise<void> {
  const isWindows = platform.includes('Windows'); // Check if the platform is Windows
  const metricName = isWindows
    ? 'LogicalDisk % Free Space'
    : 'disk_used_percent';
  const baseAlarmName = `AutoAlarm-EC2-${instanceId}-${type}StorageUtilization`;
  const thresholdKey = `autoalarm:storage-used-percent-${type.toLowerCase()}`;
  const durationTimeKey = 'autoalarm:storage-percent-duration-time';
  const durationPeriodsKey = 'autoalarm:storage-percent-duration-periods';
  const defaultThreshold = type === 'Critical' ? 90 : 80;

  const alarmProps: AlarmProps = {
    threshold: defaultThreshold,
    period: 60,
    namespace: 'CWAgent',
    evaluationPeriods: 5,
    metricName: metricName,
    dimensions: [{Name: 'InstanceId', Value: instanceId}],
  };

  try {
    configureAlarmPropsFromTags(
      alarmProps,
      tags,
      thresholdKey,
      durationTimeKey,
      durationPeriodsKey
    );
  } catch (e) {
    log.error().err(e).msg('Error configuring alarm props from tags');
    throw new Error('Error configuring alarm props from tags');
  }

  const alarmExists = await doesAlarmExist(baseAlarmName);
  if (
    !alarmExists ||
    (alarmExists && (await needsUpdate(baseAlarmName, alarmProps)))
  ) {
    await createOrUpdateAlarm(baseAlarmName, instanceId, alarmProps);
    log
      .info()
      .str('alarmName', baseAlarmName)
      .str('instanceId', instanceId)
      .msg('Storage usage alarm configured or updated.');
  } else {
    log
      .info()
      .str('alarmName', baseAlarmName)
      .str('instanceId', instanceId)
      .msg('Storage usage alarm is already up-to-date');
  }
}

async function manageMemoryAlarmForInstance(
  instanceId: string,
  platform: string,
  tags: Tag,
  type: AlarmClassification
): Promise<void> {
  const isWindows = platform.includes('Windows'); // Check if the platform is Windows
  const metricName = isWindows
    ? 'Memory % Committed Bytes In Use'
    : 'mem_used_percent';
  const baseAlarmName = `AutoAlarm-EC2-${instanceId}-${type}MemoryUtilization`;
  const defaultThreshold = type === 'Critical' ? 90 : 80;
  const thresholdKey = `autoalarm:memory-percent-above-${type.toLowerCase()}`;
  const durationTimeKey = 'autoalarm:memory-percent-duration-time';
  const durationPeriodsKey = 'autoalarm:memory-percent-duration-periods';

  const alarmProps: AlarmProps = {
    metricName: metricName,
    namespace: 'CWAgent',
    threshold: defaultThreshold, // Default thresholds
    period: 60, // Default period in seconds
    evaluationPeriods: 5, // Default number of evaluation periods
    dimensions: [{Name: 'InstanceId', Value: instanceId}],
  };

  try {
    configureAlarmPropsFromTags(
      alarmProps,
      tags,
      thresholdKey,
      durationTimeKey,
      durationPeriodsKey
    );
  } catch (e) {
    log.error().err(e).msg('Error configuring alarm props from tags');
    throw new Error('Error configuring alarm props from tags');
  }

  const alarmExists = await doesAlarmExist(baseAlarmName);
  if (
    !alarmExists ||
    (alarmExists && (await needsUpdate(baseAlarmName, alarmProps)))
  ) {
    await createOrUpdateAlarm(baseAlarmName, instanceId, alarmProps);
    log
      .info()
      .str('alarmName', baseAlarmName)
      .str('instanceId', instanceId)
      .msg(`${type} memory alarm configured or updated.`);
  } else {
    log
      .info()
      .str('alarmName', baseAlarmName)
      .str('instanceId', instanceId)
      .msg('Memory usage alarm is already up-to-date');
  }
}

async function createStatusAlarmForInstance(instanceId: string): Promise<void> {
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

async function getInstanceDetails(instanceId: string): Promise<{
  platform: string | null;
}> {
  try {
    const params = {
      InstanceIds: [instanceId],
    };
    const command = new DescribeInstancesCommand(params);
    const response = await ec2Client.send(command);

    if (
      response.Reservations &&
      response.Reservations.length > 0 &&
      response.Reservations[0].Instances &&
      response.Reservations[0].Instances.length > 0
    ) {
      const instance = response.Reservations[0].Instances[0];
      return {
        platform: instance.PlatformDetails ?? null,
      };
    } else {
      log
        .info()
        .str('instanceId', instanceId)
        .msg('No reservations found or no instances in reservation');
      return {platform: null};
    }
  } catch (error) {
    log
      .error()
      .err(error)
      .str('instanceId', instanceId)
      .msg('Failed to fetch instance details');
    return {platform: null};
  }
}

export const handler: Handler = async (event: any): Promise<void> => {
  await loggingSetup();
  log.trace().unknown('event', event).msg('Received event');
  //creating array of alarm names that we will be deleting if the instance is in a dead state.
  const alarmAnchors: string[] = [
    'WarningCPUUtilization',
    'CriticalCPUUtilization',
    'StatusCheckFailed',
    'CriticalStorageUtilization',
    'WarningStorageUtilization',
    'CriticalMemoryUtilization',
    'WarningMemoryUtilization',
  ];

  //creating sets of live and dead instance states to compare against in various alarm conditionals later on.
  const liveStates: Set<ValidInstanceState> = new Set([
    ValidInstanceState.Running,
    ValidInstanceState.Pending,
  ]);
  const deadStates: Set<ValidInstanceState> = new Set([
    ValidInstanceState.Terminated,
    ValidInstanceState.Stopped,
    ValidInstanceState.ShuttingDown,
  ]);
  try {
    if (event.source === 'aws.ec2') {
      const instanceId = event.detail['instance-id'];
      const {platform} = await getInstanceDetails(instanceId);
      if (typeof platform === 'string') {
        log
          .info()
          .str('Platform', platform)
          .msg('Fetched instance details and confirmed as strings');
      } else {
        log
          .error()
          .str('instanceId', instanceId)
          .msg('Missing or invalid platform');
        throw new Error('Missing or invalid platform');
      }
      const state = event.detail.state;
      log
        .info()
        .str('instanceId', instanceId)
        .str('state', state)
        .msg('Processing EC2 event');

      // Check if the instance is running and create alarms for cpu, storage and memory usage which should be done by default for every instance
      if (liveStates.has(state)) {
        const tags = await fetchInstanceTags(instanceId);
        log.info().str('tags', JSON.stringify(tags)).msg('Fetched tags');
        // Loop through each classification and create alarms for CPU, storage, and memory usage: Critical and Warning
        for (const classification of Object.values(AlarmClassification)) {
          await Promise.all([
            manageCPUUsageAlarmForInstance(instanceId, tags, classification),
            manageStorageAlarmForInstance(
              instanceId,
              platform,
              tags,
              classification
            ),
            manageMemoryAlarmForInstance(
              instanceId,
              platform,
              tags,
              classification
            ),
          ]);
        }
        // Check if the instance has the "autoalarm:disabled" tag set to "true" and skip creating status check alarm
        if (tags['autoalarm:disabled'] === 'true') {
          log.info().msg('autoalarm:disabled=true. Skipping alarm creation');
          // Check if the instance has the "autoalarm:disabled" tag set to "false" and create status check alarm
        } else if (tags['autoalarm:disabled'] === 'false') {
          await createStatusAlarmForInstance(instanceId);
          log.info().msg('autoalarm:disabled=false');
        }
        // Check if the instance is in a dead state and delete all alarms asycnronously
      } else if (deadStates.has(state)) {
        await Promise.all(
          alarmAnchors.map(anchor => deleteAlarm(instanceId, anchor))
        );
      }
      // Check if the event is a tag event and initiate tag event workflows
    } else if (event.source === 'aws.tag') {
      const instanceId = event.resources[0].split('/').pop();
      log.info().str('resourceId', instanceId).msg('Processing tag event');
      const {platform} = await getInstanceDetails(instanceId);
      if (typeof platform === 'string') {
        log
          .info()
          .str('platform', platform)
          .msg('Fetched instance details and confirmed as strings');
      } else {
        log
          .error()
          .str('instanceId', instanceId)
          .msg('Missing or invalid platform');
        throw new Error('Missing or invalid platform');
      }
      try {
        // The tag event bridge rule sometimes sends delayed tag signals. Here we are checking if those instances exist.
        const describeInstancesResponse = await ec2Client.send(
          new DescribeInstancesCommand({
            InstanceIds: [instanceId],
          })
        );

        const instance =
          describeInstancesResponse.Reservations?.[0]?.Instances?.[0];
        const state = instance?.State?.Name as ValidInstanceState;
        //checking our liveStates set to see if the instance is in a state that we should be managing alarms for.
        if (instance && liveStates.has(state)) {
          const tags = await fetchInstanceTags(instanceId);
          log
            .info()
            .str('resource:', instanceId)
            .str('tags', JSON.stringify(tags))
            .msg('Fetched tags');

          // Loop through each classification and create alarms for CPU, storage, and memory usage: Critical and Warning
          for (const classification of Object.values(AlarmClassification)) {
            await Promise.all([
              manageCPUUsageAlarmForInstance(instanceId, tags, classification),
              manageStorageAlarmForInstance(
                instanceId,
                platform,
                tags,
                classification
              ),
              manageMemoryAlarmForInstance(
                instanceId,
                platform,
                tags,
                classification
              ),
            ]);
          }
          // Create or delete status check alarm based on the value of the "autoalarm:disabled" tag
          if (tags['autoalarm:disabled'] === 'false') {
            await createStatusAlarmForInstance(instanceId);
          } else if (tags['autoalarm:disabled'] === 'true') {
            await deleteAlarm(instanceId, 'StatusCheckFailed');
            // If the tag exists but has an unexpected value, log the value and check for the alarm and create if it does not exist
          } else if ('autoalarm:disabled' in tags) {
            log
              .info()
              .str('resource:', instanceId)
              .str('autoalarm:disabled', tags['autoalarm:disabled'])
              .msg(
                'autoalarm:disabled tag exists but has unexpected value. checking for alarm and creating if it does not exist'
              );
            await createStatusAlarmForInstance(instanceId);
            // If the tag is not found, check for the alarm and delete if it exists
          } else {
            log
              .info()
              .msg(
                'autoalarm:disabled tag not found. checking for alarm and deleting if exists'
              );
            await deleteAlarm(instanceId, 'StatusCheckFailed');
          }
        } else {
          log
            .info()
            .str('resource', instanceId)
            .msg(
              'Instance has since been deleted or terminated. Skipping alarm management.'
            );
        }
      } catch (error) {
        log
          .error()
          .err(error)
          .str('resource', instanceId)
          .msg('Error describing instance');
      }
    }
  } catch (e) {
    log.error().err(e).msg('Error processing event');
  }
};
