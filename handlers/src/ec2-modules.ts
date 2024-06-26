import {
  DescribeInstancesCommand,
  DescribeTagsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  ListMetricsCommand,
  PutMetricAlarmCommand,
  DescribeAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import * as logging from '@nr1e/logging';
import {AlarmClassification, ValidInstanceState} from './enums';
import {AlarmProps, Tag, Dimension, PathMetrics} from './types'; //need to investigate what we were doing with Dimension.
import {
  doesAlarmExist,
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
  isPromEnabled,
} from './alarm-tools';

const log: logging.Logger = logging.getRootLogger();
const ec2Client: EC2Client = new EC2Client({});
const cloudWatchClient: CloudWatchClient = new CloudWatchClient({});
//the follwing environment variables are used to get the prometheus workspace id and the region
const prometheusWorkspaceId: string = process.env.PROMETHEUS_WORKSPACE_ID || '';
const region: string = process.env.AWS_REGION || '';

// The following const and function are used to dynamically identify the alarm configuration tags and apply them to each alarm
// that requires those configurations. The default threshold is set to 90 for critical alarms and 80 for warning alarms.
// The main handler will call these alarm function twice, once for each alarm classification type 'Critical' and 'Warning'.
const defaultThreshold = (type: AlarmClassification) =>
  type === 'CRITICAL' ? 90 : 80;

async function getAlarmConfig(
  instanceId: string,
  type: AlarmClassification,
  metric: string
): Promise<{
  alarmName: string;
  thresholdKey: string;
  durationTimeKey: string;
  durationPeriodsKey: string;
  ec2Metadata: {platform: string | null; privateIp: string | null};
}> {
  const thresholdKey = `autoalarm:${metric}-percent-above-${type.toLowerCase()}`;
  const durationTimeKey = `autoalarm:${metric}-percent-duration-time`;
  const durationPeriodsKey = `autoalarm:${metric}-percent-duration-periods`;
  const ec2Metadata = await getInstanceDetails(instanceId);

  return {
    alarmName: `AutoAlarm-EC2-${instanceId}-${type}${metric}Utilization`,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey,
    ec2Metadata,
  };
}

// This function is used to get the storage paths and their associated dimensions from CloudWatch for our ManageStorageAlarmForInstance function
async function getStoragePathsFromCloudWatch(
  instanceId: string,
  metricName: string
): Promise<PathMetrics> {
  // First, determine if the instance is running Windows
  const instanceDetailProps = await getInstanceDetails(instanceId);
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

//this function is used to get the instance OS platform type for CW metrics specific to mem and storage and private IP
// address for promQL queries
async function getInstanceDetails(
  instanceId: string
): Promise<{platform: string | null; privateIp: string}> {
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
      const platform = instance.PlatformDetails ?? null;
      const privateIp = instance.PrivateIpAddress ?? '';

      if (!platform) {
        log
          .info()
          .err('No platform details found')
          .str('instanceId', instanceId)
          .msg('No platform details found');
        throw new Error('No platform details found');
      } else {
        log
          .info()
          .str('instanceId', instanceId)
          .str('platform', platform)
          .str('privateIp', privateIp)
          .msg('EC2 instance details found');
      }

      return {platform, privateIp};
    } else {
      log
        .info()
        .str('instanceId', instanceId)
        .msg('No reservations found or no instances in reservation');
      return {platform: null, privateIp: ''};
    }
  } catch (error) {
    log
      .error()
      .err(error)
      .str('instanceId', instanceId)
      .msg('Failed to fetch instance details');
    return {platform: null, privateIp: ''};
  }
}

//manages the CPU Alarm creation
export async function manageCPUUsageAlarmForInstance(
  instanceId: string,
  tags: Tag,
  type: AlarmClassification
): Promise<void> {
  const {
    alarmName,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey,
    ec2Metadata,
  } = await getAlarmConfig(instanceId, type, 'cpu');
  const usePrometheus = await isPromEnabled(
    instanceId,
    'ec2',
    ec2Metadata.privateIp ? ec2Metadata.privateIp : '',
    prometheusWorkspaceId,
    region,
    tags
  );

  if (usePrometheus) {
    log
      .info()
      .str('instanceId', instanceId)
      .msg(
        'Prometheus metrics enabled. Skipping CloudWatch alarm creation and using Prometheus metrics instead' +
          ` and prometheus workspace id is ${prometheusWorkspaceId}`
      );
  }

  const alarmProps: AlarmProps = {
    threshold: defaultThreshold(type),
    period: 60,
    namespace: 'AWS/EC2',
    evaluationPeriods: 5,
    metricName: 'CPUUtilization',
    dimensions: [{Name: 'InstanceId', Value: instanceId}],
  };

  await createOrUpdateCWAlarm(
    alarmName,
    instanceId,
    alarmProps,
    tags,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey
  );
}

export async function manageStorageAlarmForInstance(
  instanceId: string,
  tags: Tag,
  type: AlarmClassification
): Promise<void> {
  const {
    alarmName,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey,
    ec2Metadata,
  } = await getAlarmConfig(instanceId, type, 'storage');
  // Check if the platform is Windows
  const isWindows = ec2Metadata.platform
    ? ec2Metadata.platform.toLowerCase().includes('windows')
    : false;
  const metricName = isWindows
    ? 'LogicalDisk % Free Space'
    : 'disk_used_percent';

  //const usePrometheus = isPromEnabled('');

  // if (usePrometheus) {
  //   log
  //     .info()
  //     .str('instanceId', instanceId)
  //     .msg('Prometheus metrics enabled. Skipping CloudWatch alarm creation');
  // }
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

      const storageAlarmName = `${alarmName}-${path}`;
      const alarmProps = {
        threshold: defaultThreshold(type),
        period: 60,
        namespace: 'CWAgent',
        evaluationPeriods: 5,
        metricName: metricName,
        dimensions: dimensions_props, // Use the dimensions directly from storage Paths
      };

      await createOrUpdateCWAlarm(
        storageAlarmName,
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
  const {
    alarmName,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey,
    ec2Metadata,
  } = await getAlarmConfig(instanceId, type, 'memory');
  // Check if the platform is Windows
  const privateIp = ec2Metadata.privateIp;
  const isWindows = ec2Metadata.platform
    ? ec2Metadata.platform.toLowerCase().includes('windows')
    : false;
  const metricName = isWindows
    ? 'Memory % Committed Bytes In Use'
    : 'mem_used_percent';

  //const usePrometheus = isPromEnabled('');

  const alarmProps: AlarmProps = {
    metricName: metricName,
    namespace: 'CWAgent',
    threshold: defaultThreshold(type), // Default thresholds
    period: 60, // Default period in seconds
    evaluationPeriods: 5, // Default number of evaluation periods
    dimensions: [{Name: 'InstanceId', Value: instanceId}],
  };

  //if (usePrometheus) {
  //  log
  //    .info()
  //    .str('instanceId', instanceId)
  //    .msg('Prometheus metrics enabled. Skipping CloudWatch alarm creation');
  //}
  await createOrUpdateCWAlarm(
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
    deleteCWAlarm(instanceId, 'StatusCheckFailed');
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

/* TODO: move active and inactive instance alarm management to a separate module to alarm tools and make more module
 *  for all services. This will allow for better organization and easier testing.
 */
export async function manageActiveInstanceAlarms(
  instanceId: string,
  tags: Tag,
  classification: AlarmClassification
) {
  await checkAndManageStatusAlarm(instanceId, tags);
  // Loop through classifications and manage alarms
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

export async function manageInactiveInstanceAlarms(instanceId: string) {
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'ec2',
      instanceId
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName => deleteCWAlarm(instanceId, alarmName))
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
  ValidInstanceState.Stopping, //for testing. to be removed
  ValidInstanceState.Stopped, //for testing. to be removed
  ValidInstanceState.ShuttingDown, //for testing. to be removed
]);
