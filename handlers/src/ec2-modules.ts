import {
  DescribeInstancesCommand,
  DescribeTagsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  ListMetricsCommand,
  PutMetricAlarmCommand,
} from '@aws-sdk/client-cloudwatch';
import * as logging from '@nr1e/logging';
import {AlarmClassification, ValidInstanceState} from './enums';
import {AlarmProps, Tag, Dimension, PathMetrics} from './types';
import {doesAlarmExist, createOrUpdateAlarm, deleteAlarm} from './alarm-tools';

const log = logging.getRootLogger();
const ec2Client = new EC2Client({});
const cloudWatchClient = new CloudWatchClient({});

const alarmAnchors = [
  'WarningCPUUtilization',
  'CriticalCPUUtilization',
  'StatusCheckFailed',
  'CriticalMemoryUtilization',
  'WarningMemoryUtilization',
];

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

//manages the CPU Alarm creation
export async function manageCPUUsageAlarmForInstance(
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

async function getStoragePathsFromCloudWatch(
  instanceId: string,
  metricName: string
): Promise<PathMetrics> {
  const requiredDimensions = [
    'InstanceId',
    'ImageId',
    'InstanceType',
    'device',
    'path',
    'fstype',
  ];
  const params = {
    Namespace: 'CWAgent',
    MetricName: metricName,
    Dimensions: [
      {
        Name: 'InstanceId',
        Value: instanceId,
      },
    ],
  };

  const command = new ListMetricsCommand(params);
  const response = await cloudWatchClient.send(command);
  const metrics = response.Metrics || [];
  log
    .info()
    .str('instanceId', instanceId)
    .str('metricName', metricName)
    .str('metrics', JSON.stringify(metrics))
    .msg('Fetched CloudWatch metrics');

  // Initialize a result object to store dimensions grouped by path
  const paths: PathMetrics = {};

  for (const metric of metrics) {
    // Initialize a map to hold dimension values for this metric
    const dimensionMap: Record<string, string> = {
      InstanceId: instanceId,
      ImageId: '',
      InstanceType: '',
      device: '',
      path: '',
      fstype: '',
    };

    // Populate the dimension map with metric's values
    metric.Dimensions?.forEach(dim => {
      if (dim.Name && dim.Value && requiredDimensions.includes(dim.Name)) {
        dimensionMap[dim.Name] = dim.Value;
      }
    });

    // Extract the path dimension and ensure it's defined
    const path = dimensionMap['path'];
    if (path) {
      // Build an array of dimensions excluding 'path' itself
      const dimensionsArray = requiredDimensions
        .filter(name => name !== 'path')
        .map(name => ({Name: name, Value: dimensionMap[name]}))
        .concat([{Name: 'path', Value: path}]);

      // Add this array to the paths object using the path as the key
      paths[path] = dimensionsArray;
    }
  }

  return paths;
}

export async function manageStorageAlarmForInstance(
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
  const thresholdKey = `autoalarm:storage-used-percent-${type.toLowerCase()}`;
  const durationTimeKey = 'autoalarm:storage-percent-duration-time';
  const durationPeriodsKey = 'autoalarm:storage-percent-duration-periods';
  const defaultThreshold = type === 'Critical' ? 90 : 80;

  // Fetch storage paths and their associated dimensions
  const storagePaths = await getStoragePathsFromCloudWatch(
    instanceId,
    metricName
  );

  const paths = Object.keys(storagePaths);
  if (paths.length > 0) {
    for (const path of paths) {
      const dimensions_props = storagePaths[path];
      log
        .info()
        .str('instanceId', instanceId)
        .str('path', path)
        .str('dimensions', JSON.stringify(dimensions_props))
        .msg('found dimensions for storage path');

      const alarmName = `AutoAlarm-EC2-${instanceId}-${type}StorageUtilization-${path}`;
      const alarmProps = {
        threshold: defaultThreshold,
        period: 60,
        namespace: 'CWAgent',
        evaluationPeriods: 5,
        metricName: metricName,
        dimensions: dimensions_props, // Use the dimensions directly from storage Paths
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
  } else {
    log
      .info()
      .str('instanceId', instanceId)
      .msg(
        'CloudWatch metrics not found for storage paths. Skipping alarm creation.'
      );
  }
}

export async function manageMemoryAlarmForInstance(
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

export async function createStatusAlarmForInstance(
  instanceId: string,
  doesAlarmExist: Function
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

async function checkAndManageStatusAlarm(instanceId: string, tags: Tag) {
  if (tags['autoalarm:disabled'] === 'true') {
    deleteAlarm(instanceId, 'StatusCheckFailed');
    log.info().msg('Status check alarm creation skipped due to tag settings.');
  } else if (tags['autoalarm:disabled'] === 'false') {
    // Create status check alarm if not disabled
    await createStatusAlarmForInstance(instanceId, doesAlarmExist);
  } else if (tags['autoalarm:disabled'] in tags) {
    log
      .warn()
      .msg(
        'autoalarm:disabled tag exists but has unexpected value. checking for alarm and creating if it does not exist'
      );
    await createStatusAlarmForInstance(instanceId, doesAlarmExist);
  }
}

export async function manageActiveInstanceAlarms(
  instanceId: string,
  tags: Tag
) {
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

async function getStorageAlarmAnchors(instanceId: string): Promise<void> {
  const instanceDetailProps = await getInstancePlatform(instanceId);
  // Check if the platform is Windows
  const isWindows = instanceDetailProps.platform
    ? instanceDetailProps.platform.toLowerCase().includes('windows')
    : false;
  const metricName = isWindows
    ? 'LogicalDisk % Free Space'
    : 'disk_used_percent';
  // Fetch storage paths and their associated dimensions
  const storagePaths = await getStoragePathsFromCloudWatch(
    instanceId,
    metricName
  );

  const paths = Object.keys(storagePaths);
  if (paths.length > 0) {
    for (const path of paths) {
      const dimensions_props = storagePaths[path];
      log
        .info()
        .str('instanceId', instanceId)
        .str('path', path)
        .str('dimensions', JSON.stringify(dimensions_props))
        .msg('found dimensions for storage path');

      for (const classification of Object.values(AlarmClassification)) {
        alarmAnchors.push(`${classification}StorageUtilization-${path}`);
      }
    }
  }
}

export async function manageInactiveInstanceAlarms(instanceId: string) {
  await getStorageAlarmAnchors(instanceId);
  try {
    await Promise.all(
      alarmAnchors.map(anchor => deleteAlarm(instanceId, anchor))
    );
  } catch (e) {
    log.error().err(e).msg(`Error deleting alarms: ${e}`);
    throw new Error(`Error deleting alarms: ${e}`);
  }
}

export async function getEC2IdAndState(
  event: any
): Promise<{instanceId: string; state: ValidInstanceState}> {
  const instanceId = event.resources[0].split('/').pop();
  log.info().str('resourceId', instanceId).msg('Processing tag event');

  const describeInstancesResponse = await ec2Client.send(
    new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    })
  );
  const instance = describeInstancesResponse.Reservations?.[0]?.Instances?.[0];
  const state = instance?.State?.Name as ValidInstanceState;
  return {instanceId: instanceId, state: state};
}

export async function fetchInstanceTags(
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

export const liveStates: Set<ValidInstanceState> = new Set([
  ValidInstanceState.Running,
  ValidInstanceState.Pending,
]);

export const deadStates: Set<ValidInstanceState> = new Set([
  ValidInstanceState.Terminated,
  ValidInstanceState.Stopping,
  ValidInstanceState.Stopped,
  ValidInstanceState.ShuttingDown,
]);