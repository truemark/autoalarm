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

const log = logging.getRootLogger();
const ec2Client = new EC2Client({});
const cloudWatchClient = new CloudWatchClient({});

async function loggingSetup() {
  try {
    await logging.initialize({
      svc: 'AutoAlarm',
      name: 'main-handler',
      level: 'trace',
    });
  } catch (error) {
    // Fallback logging initialization (e.g., to console)
    console.error('Failed to initialize custom logger:', error);
    throw new Error(`Failed to initialize custom logger: ${error}`);
  }
}

async function doesAlarmExist(alarmName: string): Promise<boolean> {
  const response = await cloudWatchClient.send(
    new DescribeAlarmsCommand({AlarmNames: [alarmName]})
  );
  return (response.MetricAlarms?.length ?? 0) > 0;
}

//this function is used to get the instance OS platform type
async function getInstancePlatform(
  instanceId: string
): Promise<{platform: string | null}> {
  try {
    const describeInstancesCommand = new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    });
    const describeInstancesResponse = await ec2Client.send(
      describeInstancesCommand
    );

    if (
      describeInstancesResponse.Reservations &&
      describeInstancesResponse.Reservations.length > 0 &&
      describeInstancesResponse.Reservations[0].Instances &&
      describeInstancesResponse.Reservations[0].Instances.length > 0
    ) {
      const instance = describeInstancesResponse.Reservations[0].Instances[0];
      if (!instance.PlatformDetails) {
        log
          .info()
          .err('No platform details found')
          .str('instanceId', instanceId)
          .msg('No platform details found');
        throw new Error('No platform details found');
      } else if (instance.PlatformDetails) {
        log
          .info()
          .str('instanceId', instanceId)
          .str('platform', instance.PlatformDetails)
          .msg('Platform details found');
      }
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

function configureAlarmPropsFromTags(
  alarmProps: AlarmProps,
  tags: Tag,
  thresholdKey: string,
  durationTimeKey: string,
  durationPeriodsKey: string
): void {
  // Adjust threshold based on tags or use default if not present as defined in alarm props
  if (!tags[thresholdKey]) {
    log.info().msg('Threshold tag not found, using default');
  } else if (tags[thresholdKey]) {
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

  // Adjust period based on tags or use default if not present as defined in alarm props
  if (!tags[durationTimeKey]) {
    log.info().msg('Period tag not found, using default');
  } else if (tags[durationTimeKey]) {
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

  // Adjust evaluation periods based on tags or use default if not present as defined in alarm props
  if (!tags[durationPeriodsKey]) {
    log.info().msg('Evaluation periods tag not found, using default');
  } else if (tags[durationPeriodsKey]) {
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

//check if cloudwatch agent tag has been set to true. Should only be used if CW Agent has been installed on the instance

async function createOrUpdateAlarm(
  alarmName: string,
  instanceId: string,
  props: AlarmProps,
  tags: Tag,
  thresholdKey: string,
  durationTimeKey: string,
  durationPeriodsKey: string
) {
  try {
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Configuring alarm props from tags');
    configureAlarmPropsFromTags(
      props,
      tags,
      thresholdKey,
      durationTimeKey,
      durationPeriodsKey
    );
  } catch (e) {
    log.error().err(e).msg('Error configuring alarm props from tags');
    throw new Error('Error configuring alarm props from tags');
  }
  const alarmExists = await doesAlarmExist(alarmName);
  if (!alarmExists || (alarmExists && (await needsUpdate(alarmName, props)))) {
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
        .msg(`${alarmName} Alarm configured or updated.`);
    } catch (e) {
      log
        .error()
        .err(e)
        .str('alarmName', alarmName)
        .str('instanceId', instanceId)
        .msg(
          `Failed to create or update ${alarmName} alarm due to an error ${e}`
        );
    }
  }
}

async function manageCPUUsageAlarmForInstance(
  instanceId: string,
  tags: Tag,
  type: AlarmClassification
): Promise<void> {
  const alarmName = `AutoAlarm-EC2-${instanceId}-${type}CPUUtilization`;
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

  await createOrUpdateAlarm(
    alarmName,
    instanceId,
    alarmProps,
    tags,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey
  );
}

async function manageStorageAlarmForInstance(
  instanceId: string,
  tags: Tag,
  type: AlarmClassification
): Promise<void> {
  const instanceDetailProps = await getInstancePlatform(instanceId);
  // Check if the platform is Windows
  const isWindows = instanceDetailProps.platform
    ? instanceDetailProps.platform.toLowerCase().includes('windows')
    : false;
  const metricName = isWindows
    ? 'LogicalDisk % Free Space'
    : 'disk_used_percent';
  const alarmName = `AutoAlarm-EC2-${instanceId}-${type}StorageUtilization`;
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

  await createOrUpdateAlarm(
    alarmName,
    instanceId,
    alarmProps,
    tags,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey
  );
}

async function manageMemoryAlarmForInstance(
  instanceId: string,
  tags: Tag,
  type: AlarmClassification
): Promise<void> {
  const instanceDetailProps = await getInstancePlatform(instanceId);
  // Check if the platform is Windows
  const isWindows = instanceDetailProps.platform
    ? instanceDetailProps.platform.toLowerCase().includes('windows')
    : false;
  const metricName = isWindows
    ? 'Memory % Committed Bytes In Use'
    : 'mem_used_percent';
  const alarmName = `AutoAlarm-EC2-${instanceId}-${type}MemoryUtilization`;
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

  await createOrUpdateAlarm(
    alarmName,
    instanceId,
    alarmProps,
    tags,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey
  );
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
    log
      .info()
      .str('instanceId', instanceId)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched instance tags');
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

const liveStates: Set<ValidInstanceState> = new Set([
  ValidInstanceState.Running,
  ValidInstanceState.Pending,
]);

const deadStates: Set<ValidInstanceState> = new Set([
  ValidInstanceState.Terminated,
  ValidInstanceState.Stopping,
  ValidInstanceState.Stopped,
  ValidInstanceState.ShuttingDown,
]);

async function manageActiveInstanceAlarms(instanceId: string, tags: Tag) {
  await checkAndManageStatusAlarm(instanceId, tags);
  // Loop through classifications and manage alarms
  for (const classification of Object.values(AlarmClassification)) {
    try {
      await Promise.all([
        manageCPUUsageAlarmForInstance(instanceId, tags, classification),
        manageStorageAlarmForInstance(instanceId, tags, classification),
        manageMemoryAlarmForInstance(instanceId, tags, classification),
      ]);
    } catch (e) {
      log.error().err(e).msg('Error managing alarms for instance');
      throw new Error(`Error managing alarms for instance: ${e}`);
    }
  }
}

async function manageInactiveInstanceAlarms(instanceId: string) {
  const alarmAnchors = [
    'WarningCPUUtilization',
    'CriticalCPUUtilization',
    'StatusCheckFailed',
    'CriticalStorageUtilization',
    'WarningStorageUtilization',
    'CriticalMemoryUtilization',
    'WarningMemoryUtilization',
  ];

  // Delete all alarms associated with the instance
  try {
    await Promise.all(
      alarmAnchors.map(anchor => deleteAlarm(instanceId, anchor))
    );
  } catch (e) {
    log.error().err(e).msg(`Error deleting alarms: ${e}`);
    throw new Error(`Error deleting alarms: ${e}`);
  }
}

async function checkAndManageStatusAlarm(instanceId: string, tags: Tag) {
  if (tags['autoalarm:disabled'] === 'true') {
    deleteAlarm(instanceId, 'StatusCheckFailed');
    log.info().msg('Status check alarm creation skipped due to tag settings.');
  } else if (tags['autoalarm:disabled'] === 'false') {
    // Create status check alarm if not disabled
    await createStatusAlarmForInstance(instanceId);
  } else if (tags['autoalarm:disabled'] in tags) {
    log
      .warn()
      .msg(
        'autoalarm:disabled tag exists but has unexpected value. checking for alarm and creating if it does not exist'
      );
    await createStatusAlarmForInstance(instanceId);
  }
}

async function processEC2Event(event: any) {
  const instanceId = event.detail['instance-id'];
  const state = event.detail.state;
  const tags = await fetchInstanceTags(instanceId);

  if (liveStates.has(state)) {
    await manageActiveInstanceAlarms(instanceId, tags);
  } else if (deadStates.has(state)) {
    await manageInactiveInstanceAlarms(instanceId);
  }
}

async function processTagEvent(event: any) {
  const instanceId = event.resources[0].split('/').pop();
  log.info().str('resourceId', instanceId).msg('Processing tag event');
  //check if the instance is in live state
  const describeInstancesResponse = await ec2Client.send(
    new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    })
  );
  const instance = describeInstancesResponse.Reservations?.[0]?.Instances?.[0];
  const state = instance?.State?.Name as ValidInstanceState;
  //checking our liveStates set to see if the instance is in a state that we should be managing alarms for.
  if (instance && liveStates.has(state)) {
    const tags = await fetchInstanceTags(instanceId);
    await manageActiveInstanceAlarms(instanceId, tags);
  }
}

export const handler: Handler = async (event: any): Promise<void> => {
  await loggingSetup();
  log.trace().unknown('event', event).msg('Received event');
  try {
    switch (event.source) {
      case 'aws.ec2':
        await processEC2Event(event);
        break;
      case 'aws.tag':
        await processTagEvent(event);
        break;
      default:
        log.warn().msg('Unhandled event source');
        break;
    }
  } catch (error) {
    log.error().err(error).msg('Error processing event');
  }
};
