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
//import {AmpClient, QueryCommand} from '@aws-sdk/client-amp';
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
  type: AlarmClassification,
  useProm: boolean
): Promise<void> {
  const alarmName = `AutoAlarm-EC2-${instanceId}-${type}CPUUtilization`;
  const thresholdKey = `autoalarm:cpu-percent-above-${type.toLowerCase()}`;
  const durationTimeKey = 'autoalarm:cpu-percent-duration-time';
  const durationPeriodsKey = 'autoalarm:cpu-percent-duration-periods';
  const defaultThreshold = type === 'Critical' ? 99 : 97;
  const usePrometheus = useProm;

  if (usePrometheus) {
    log
      .info()
      .str('instanceId', instanceId)
      .msg('Prometheus metrics enabled. Skipping CloudWatch alarm creation');
  }

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
  // First, determine if the instance is running Windows
  const instanceDetailProps = await getInstancePlatform(instanceId);
  const isWindows = instanceDetailProps.platform
    ? instanceDetailProps.platform.toLowerCase().includes('windows')
    : false;

  // Set required dimensions based on the operating system
  const requiredDimensions = isWindows
    ? [
        'InstanceId',
        'ImageId',
        'InstanceType',
        'instance', // Adjusted for Windows
        'objectname', // Adjusted for Windows
      ]
    : ['InstanceId', 'ImageId', 'InstanceType', 'device', 'path', 'fstype'];

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
    const dimensionMap: Record<string, string> = {};
    requiredDimensions.forEach(dim => {
      dimensionMap[dim] = ''; // Initialize all required dimensions with empty strings
    });
    dimensionMap['InstanceId'] = instanceId; // Always set InstanceId

    // Populate the dimension map with metric's values
    metric.Dimensions?.forEach(dim => {
      if (dim.Name && dim.Value && requiredDimensions.includes(dim.Name)) {
        dimensionMap[dim.Name] = dim.Value;
      }
    });

    // Extract the path dimension based on the OS and ensure it's defined
    const pathKey = isWindows ? 'instance' : 'path';
    const path = dimensionMap[pathKey];
    if (path) {
      // Build an array of dimensions
      const dimensionsArray = requiredDimensions.map(name => ({
        Name: name,
        Value: dimensionMap[name],
      }));

      // Add this array to the paths object using the path as the key
      paths[path] = dimensionsArray;
    }
  }

  return paths;
}

export async function manageStorageAlarmForInstance(
  instanceId: string,
  tags: Tag,
  type: AlarmClassification,
  useProm: boolean
): Promise<void> {
  const instanceDetailProps = await getInstancePlatform(instanceId);
  // Check if the platform is Windows
  const isWindows = instanceDetailProps.platform
    ? instanceDetailProps.platform.toLowerCase().includes('windows')
    : false;
  const metricName = isWindows
    ? 'LogicalDisk % Free Space'
    : 'disk_used_percent';
  const usePrometheus = useProm;
  const thresholdKey = `autoalarm:storage-used-percent-${type.toLowerCase()}`;
  const durationTimeKey = 'autoalarm:storage-percent-duration-time';
  const durationPeriodsKey = 'autoalarm:storage-percent-duration-periods';
  const defaultThreshold = type === 'Critical' ? 90 : 80;

  if (usePrometheus) {
    log
      .info()
      .str('instanceId', instanceId)
      .msg('Prometheus metrics enabled. Skipping CloudWatch alarm creation');
  }
  // Fetch storage paths and their associated dimensions for cloudwatch alarms
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
  type: AlarmClassification,
  useProm: boolean
): Promise<void> {
  const instanceDetailProps = await getInstancePlatform(instanceId);
  // Check if the platform is Windows
  const isWindows = instanceDetailProps.platform
    ? instanceDetailProps.platform.toLowerCase().includes('windows')
    : false;
  const metricName = isWindows
    ? 'Memory % Committed Bytes In Use'
    : 'mem_used_percent';
  const usePrometheus = useProm;
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

  if (usePrometheus) {
    log
      .info()
      .str('instanceId', instanceId)
      .msg('Prometheus metrics enabled. Skipping CloudWatch alarm creation');
  }
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
  tags: Tag,
  classification: AlarmClassification,
  useProm: boolean
) {
  await checkAndManageStatusAlarm(instanceId, tags);
  // Loop through classifications and manage alarms
  try {
    await Promise.all([
      manageCPUUsageAlarmForInstance(instanceId, tags, classification, useProm),
      manageStorageAlarmForInstance(instanceId, tags, classification, useProm),
      manageMemoryAlarmForInstance(instanceId, tags, classification, useProm),
    ]);
  } catch (e) {
    log.error().err(e).msg('Error managing alarms for instance');
    throw new Error(`Error managing alarms for instance: ${e}`);
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

//async function checkPromMetrics(instanceId: string): Promise<boolean> {
//  try {
//    const workspaceId = 'your-workspace-id'; // Replace with your actual workspace ID
//    const query = `up{instance="${instanceId}"}`; // Adjust query to your actual metric labels
//    const command = new QueryCommand({workspaceId, query});
//    const response = await AmpClient.send(command);
//
//    // Check if there are any data points in the response
//    const metricsExist = response.data?.result?.length > 0;
//    if (metricsExist) {
//      log
//        .info()
//        .str('instanceId', instanceId)
//        .msg('Metrics are being sent to Prometheus');
//    } else {
//      log
//        .info()
//        .str('instanceId', instanceId)
//        .msg('Metrics are not being sent to Prometheus');
//    }
//    return metricsExist;
//  } catch (error) {
//    log
//      .error()
//      .err(error)
//      .str('instanceId', instanceId)
//      .msg('Failed to query Prometheus metrics');
//    throw new Error(
//      `Failed to query Prometheus metrics for instance ${instanceId}: ${error}`
//    );
//  }
//}

// Check if the Prometheus tag is set to true and if metrics are being sent to Prometheus
export async function isPromEnabled(instanceId: string): Promise<boolean> {
  try {
    const tags = await fetchInstanceTags(instanceId);
    if (tags['Prometheus'] && tags['Prometheus'] === 'true') {
      log
        .info()
        .str('instanceId', instanceId)
        .msg(
          'Prometheus tag found. Checking if metrics are being sent to Prometheus'
        );
      // Check if metrics are being sent to Prometheus and return true or false for alarms
      //const useProm = await checkPromMetrics(instanceId);
      // log
      //   .info()
      //   .str('instanceId', instanceId)
      //   .msg(`Prometheus metrics enabled=${useProm}`);
      return true; //this will be used for the useProm variable once we finish testing the inital logic
    } else if (
      (tags['Prometheus'] && tags['Prometheus'] === 'false') ||
      !tags['Prometheus'] ||
      (tags['Prometheus'] !== 'true' && tags['Prometheus'] !== 'false')
    ) {
      log
        .info()
        .str('instanceId', instanceId)
        .str('tags', JSON.stringify(tags))
        .msg('Prometheus tag not found or not set to true');
      return false;
    } else {
      return false;
    }
  } catch (error) {
    log
      .error()
      .err(error)
      .str('instanceId', instanceId)
      .msg('Failed to check Prometheus tag');
    throw new Error(
      `Failed to check Prometheus tag for instance ${instanceId}: ${error}`
    );
  }
}

export const liveStates: Set<ValidInstanceState> = new Set([
  ValidInstanceState.Running,
  ValidInstanceState.Pending,
]);

export const deadStates: Set<ValidInstanceState> = new Set([
  ValidInstanceState.Terminated,
  ValidInstanceState.Stopping, //for testing. to be removed
  ValidInstanceState.Stopped, //for testing. to be removed
  ValidInstanceState.ShuttingDown, //for testing. to be removed
]);
