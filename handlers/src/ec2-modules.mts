import {
  DescribeInstancesCommand,
  DescribeTagsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  ListMetricsCommand,
  PutMetricAlarmCommand,
} from '@aws-sdk/client-cloudwatch';
import * as logging from '@nr1e/logging';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {ValidInstanceState} from './enums.mjs';
import {PathMetrics, Tag, EC2AlarmManagerArray} from './types.mjs'; //need to investigate what we were doing with Dimension.
import {
  deleteAlarm,
  doesAlarmExist,
  getCWAlarmsForInstance,
  handleAnomalyAlarms,
  handleStaticAlarms,
  massDeleteAlarms,
} from './alarm-tools.mjs';
import {
  MetricAlarmConfig,
  MetricAlarmConfigs,
  MetricAlarmOptions,
  parseMetricAlarmOptions,
} from './alarm-config.mjs';
import {
  batchPromRulesDeletion,
  batchUpdatePromRules,
  queryPrometheusForService,
} from './prometheus-tools.mjs';

const log: logging.Logger = logging.getLogger('ec2-modules');
export const prometheusWorkspaceId: string =
  process.env.PROMETHEUS_WORKSPACE_ID || '';
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const ec2Client: EC2Client = new EC2Client({
  region: region,
  retryStrategy: retryStrategy,
});
const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region: region,
  retryStrategy: retryStrategy,
});

// This function is used to confirm that memory metrics are being reported for an instance
async function getMemoryMetricsFromCloudWatch(
  instanceId: string,
  metricName: string,
): Promise<boolean> {
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
    .str('function', 'getMemoryMetricsFromCloudWatch')
    .str('instanceId', instanceId)
    .str('metricName', metricName)
    .str('metrics', JSON.stringify(metrics))
    .msg('Fetched CloudWatch metrics');

  if (metrics.length >= 1) {
    log
      .info()
      .str('function', 'getMemoryMetricsFromCloudWatch')
      .str('instanceId', instanceId)
      .str('metricName', metricName)
      .msg('Memory metrics found for instance');
    return true;
  } else {
    return false;
  }
}

// This function is used to get the storage paths and their associated dimensions from CloudWatch for our ManageStorageAlarmForInstance function
async function getStoragePathsFromCloudWatch(
  instanceId: string,
  metricName: string,
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
    .str('function', 'getStoragePathsFromCloudWatch')
    .str('instanceId', instanceId)
    .str('metricName', metricName)
    .str('metrics', JSON.stringify(metrics))
    .msg('Fetched CloudWatch metrics');

  // Initialize a result object to store dimensions grouped by path
  const paths: PathMetrics = {};

  for (const metric of metrics) {
    // Initialize a map to hold dimension values for this metric
    const dimensionMap: Record<string, string> = {};
    requiredDimensions.forEach((dim) => {
      dimensionMap[dim] = ''; // Initialize all required dimensions with empty strings
    });
    dimensionMap['InstanceId'] = instanceId; // Always set InstanceId

    // Populate the dimension map with metric's values
    metric.Dimensions?.forEach((dim) => {
      if (dim.Name && dim.Value && requiredDimensions.includes(dim.Name)) {
        dimensionMap[dim.Name] = dim.Value;
      }
    });

    // Extract the path dimension based on the OS and ensure it's defined
    const pathKey = isWindows ? 'instance' : 'path';
    const path = dimensionMap[pathKey];
    if (
      path &&
      !path.startsWith('/snap') &&
      !path.startsWith('/run') &&
      !path.startsWith('/dev/shm') &&
      !path.startsWith('/boot')
    ) {
      // Build an array of dimensions
      // Adds this array to the path object using the path as the key
      paths[path] = requiredDimensions.map((name) => ({
        Name: name,
        Value: dimensionMap[name],
      }));
    }
  }

  return paths;
}

//this function is used to get the instance OS platform type for CW metrics specific to mem and storage and private IP
// address for promQL queries
async function getInstanceDetails(
  instanceId: string,
): Promise<{platform: string | null; privateIP: string | null}> {
  try {
    const describeInstancesCommand = new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    });
    const describeInstancesResponse = await ec2Client.send(
      describeInstancesCommand,
    );

    if (
      describeInstancesResponse.Reservations &&
      describeInstancesResponse.Reservations.length > 0 &&
      describeInstancesResponse.Reservations[0].Instances &&
      describeInstancesResponse.Reservations[0].Instances.length > 0
    ) {
      const instance = describeInstancesResponse.Reservations[0].Instances[0];
      const platform = instance.PlatformDetails ?? null;
      const privateIP = instance.PrivateIpAddress ?? '';

      if (!platform) {
        log
          .info()
          .str('function', 'getInstanceDetails')
          .err('No platform details found')
          .str('instanceId', instanceId)
          .msg('No platform details found');
        throw new Error('No platform details found');
      }
      log
        .info()
        .str('function', 'getInstanceDetails')
        .str('instanceId', instanceId)
        .str('platform', platform)
        .str('privateIP', privateIP)
        .msg('Fetched instance details');
      return {platform, privateIP};
    } else {
      log
        .info()
        .str('function', 'getInstanceDetails')
        .str('instanceId', instanceId)
        .msg('No reservations found or no instances in reservation');
      return {platform: null, privateIP: ''};
    }
  } catch (error) {
    log
      .error()
      .str('function', 'getInstanceDetails')
      .err(error)
      .str('instanceId', instanceId)
      .msg('Failed to fetch instance details');
    return {platform: null, privateIP: ''};
  }
}

export async function createStatusAlarmForInstance(
  instanceId: string,
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
        Period: 60,
        Statistic: 'Average',
        Threshold: 0,
        ActionsEnabled: false,
        Dimensions: [{Name: 'InstanceId', Value: instanceId}],
        Tags: [{Key: 'severity', Value: 'critical'}],
        TreatMissingData: 'breaching',
      }),
    );
    log
      .info()
      .str('function', 'createStatusAlarmForInstance')
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Created alarm');
  } else {
    log
      .info()
      .str('function', 'createStatusAlarmForInstance')
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Alarm already exists for instance');
  }
}

async function checkAndManageStatusAlarm(instanceId: string, tags: Tag) {
  if (tags['autoalarm:enabled'] === 'false') {
    await deleteAlarm(`AutoAlarm-EC2-${instanceId}-StatusCheckFailed`);
    log.info().msg('Status check alarm creation skipped due to tag settings.');
  } else if (tags['autoalarm:enabled'] === 'true') {
    // Create status check alarm if not disabled
    await createStatusAlarmForInstance(instanceId);
  } else if (tags['autoalarm:enabled'] in tags) {
    log
      .warn()
      .str('function', 'checkAndManageStatusAlarm')
      .msg(
        'autoalarm:enabled tag exists but has unexpected value. checking for alarm and creating if it does not exist',
      );
    await createStatusAlarmForInstance(instanceId);
  }
}

const metricConfigs = MetricAlarmConfigs['EC2'];

export async function fetchInstanceTags(
  instanceId: string,
): Promise<{[key: string]: string}> {
  try {
    const response = await ec2Client.send(
      new DescribeTagsCommand({
        Filters: [{Name: 'resource-id', Values: [instanceId]}],
      }),
    );

    const tags: {[key: string]: string} = {};
    response.Tags?.forEach((tag) => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .info()
      .str('function', 'fetchInstanceTags')
      .str('instanceId', instanceId)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched instance tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchInstanceTags')
      .err(error)
      .str('instanceId', instanceId)
      .msg('Error fetching instance tags');
    return {};
  }
}

async function handleAlarmCreation(
  config: MetricAlarmConfig,
  instanceId: string,
  isWindows: boolean,
  updatedDefaults: MetricAlarmOptions,
  alarmType: 'anomaly' | 'static',
  alarmsToKeep: Set<string>,
) {
  const alarmMessage =
    alarmType === 'anomaly' ? 'anomaly detection alarm' : 'static alarm';
  const alarmFunction =
    alarmType === 'anomaly' ? handleAnomalyAlarms : handleStaticAlarms;

  switch (true) {
    case config.tagKey.includes('memory'): {
      // Set the correct metric name before making the CloudWatch call
      config.metricName = isWindows
        ? 'Memory % Committed Bytes In Use'
        : 'mem_used_percent';

      const memoryMetricsExist = await getMemoryMetricsFromCloudWatch(
        instanceId,
        config.metricName,
      );

      if (memoryMetricsExist) {
        log
          .info()
          .str('function', 'manageActiveEC2InstanceAlarms')
          .str('EC2 instance ID', instanceId)
          .msg(
            `Found memory metrics. Proceeding with memory ${alarmMessage} creation`,
          );

        const alarms = await alarmFunction(
          config,
          'EC2',
          instanceId,
          [{Name: 'InstanceId', Value: instanceId}],
          updatedDefaults,
        );
        alarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      } else {
        log
          .warn()
          .str('function', 'manageActiveEC2InstanceAlarms')
          .str('EC2 instance ID', instanceId)
          .msg(
            `No memory metrics found. Skipping memory ${alarmMessage} creation`,
          );
      }
      break;
    }
    case config.tagKey.includes('storage'): {
      // Set the correct metric name before making the CloudWatch call
      config.metricName = isWindows
        ? 'LogicalDisk % Free Space'
        : 'disk_used_percent';

      const storagePaths = await getStoragePathsFromCloudWatch(
        instanceId,
        config.metricName,
      );

      if (Object.keys(storagePaths).length > 0) {
        const paths = Object.keys(storagePaths);
        for (const path of paths) {
          const dimensions_props = storagePaths[path].map((dimension) => ({
            Name: dimension.Name,
            Value: dimension.Value,
          }));
          log
            .info()
            .str('function', 'handleAlarmCreation')
            .str('EC2 instance ID', instanceId)
            .obj('dimensions', dimensions_props)
            .msg(
              `Found storage metrics. Proceeding with storage ${alarmMessage} creation`,
            );

          const alarms = await alarmFunction(
            config,
            'EC2',
            instanceId,
            [...dimensions_props],
            updatedDefaults,
            path,
          );
          alarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
        }
      } else {
        log
          .info()
          .str('function', 'handleAlarmCreation')
          .str('EC2 instance ID', instanceId)
          .msg(
            `No storage metrics found. Skipping storage ${alarmMessage} creation`,
          );
      }
      break;
    }
    default: {
      log
        .info()
        .str('function', 'handleAlarmCreation')
        .str('EC2 instance ID', instanceId)
        .msg(
          `Metrics for ${alarmType} alarm are OS agnostic. Proceeding with ${alarmMessage} creation`,
        );

      const alarms = await alarmFunction(
        config,
        'EC2',
        instanceId,
        [{Name: 'InstanceId', Value: instanceId}],
        updatedDefaults,
      );
      alarms.forEach((alarmName) => alarmsToKeep.add(alarmName));
      break;
    }
  }
}

// Helper function to handle CloudWatch alarm logic
async function handleCloudWatchAlarms(
  instanceID: string,
  tags: Tag,
  isWindows: boolean,
) {
  const alarmsToKeep = new Set<string>();

  await checkAndManageStatusAlarm(instanceID, tags);
  alarmsToKeep.add(`AutoAlarm-EC2-${instanceID}-StatusCheckFailed`);

  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'manageActiveEC2InstanceAlarms')
      .obj('config', config)
      .str('EC2 instance ID', instanceID)
      .msg('Processing metric configuration');

    const tagValue = tags[`autoalarm:${config.tagKey}`];
    const updatedDefaults = parseMetricAlarmOptions(
      tagValue || '',
      config.defaults,
    );

    if (config.defaultCreate || tagValue !== undefined) {
      await handleAlarmCreation(
        config,
        instanceID,
        isWindows,
        updatedDefaults,
        config.tagKey.includes('anomaly') ? 'anomaly' : 'static',
        alarmsToKeep,
      );
    }
  }

  const existingAlarms = await getCWAlarmsForInstance('EC2', instanceID);
  const alarmsToDelete = existingAlarms.filter(
    (alarm) => !alarmsToKeep.has(alarm),
  );

  log
    .info()
    .obj('alarms to delete', alarmsToDelete)
    .msg('Deleting unnecessary alarms');

  await cloudWatchClient.send(
    new DeleteAlarmsCommand({AlarmNames: alarmsToDelete}),
  );
}

// Helper function to get disabled alarms
async function getDisabledAlarms(
  deleteInstanceAlarmsArray: EC2AlarmManagerArray,
): Promise<string[]> {
  const disabledAlarmsPromises = deleteInstanceAlarmsArray.flatMap(
    ({instanceID}) => getCWAlarmsForInstance('EC2', instanceID),
  );
  return (await Promise.all(disabledAlarmsPromises)).flat();
}

export async function manageActiveEC2InstanceAlarms(
  activeInstancesInfoArray: EC2AlarmManagerArray,
) {
  const prometheusArray: EC2AlarmManagerArray = [];
  const deleteInstanceAlarmsArray: EC2AlarmManagerArray = [];

  const instanceIPsReportingToPrometheus: string[] = prometheusWorkspaceId
    ? await queryPrometheusForService('ec2', prometheusWorkspaceId, region)
    : [];

  for (const {instanceID, tags, state} of activeInstancesInfoArray) {
    log
      .info()
      .str('function', 'manageActiveEC2InstanceAlarms')
      .str('EC2 instance ID', instanceID)
      .msg('Starting alarm management process');

    const ec2Metadata = await getInstanceDetails(instanceID);
    const isWindows = ec2Metadata.platform?.includes('Windows') || false;
    const privateIP = ec2Metadata.privateIP || '';
    const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';

    if (!isAlarmEnabled) {
      log
        .info()
        .str('function', 'manageActiveEC2InstanceAlarms')
        .str('EC2 instance ID', instanceID)
        .msg('Alarm creation disabled by tag settings');
      deleteInstanceAlarmsArray.push({instanceID, tags, state});
      continue; // Skip further processing for this instance
    }

    // Check if instance reports to Prometheus and process Prometheus alarms
    if (
      prometheusWorkspaceId &&
      tags['autoalarm:target'] !== 'cloudwatch' &&
      instanceIPsReportingToPrometheus.includes(privateIP)
    ) {
      prometheusArray.push({instanceID, tags, state, ec2Metadata});
      continue; // Skip CW alarms for this instance.
    }

    // Handle CloudWatch alarms
    await handleCloudWatchAlarms(instanceID, tags, isWindows);
  }

  // Process Prometheus alarms
  if (prometheusArray.length > 0) {
    await batchUpdatePromRules(prometheusWorkspaceId, 'ec2', prometheusArray);
  }

  // Delete CloudWatch alarms for instances that have autoalarm:enabled set to false if they exist.
  log
    .info()
    .msg(
      'Deleting CW alarms for instances with autoalarm:enabled set to false',
    );
  const disabledAlarms = await getDisabledAlarms(deleteInstanceAlarmsArray);
  await massDeleteAlarms(disabledAlarms);

  // Delete Prometheus alarms for instances that have autoalarm:enabled set to false if they exist.
  log
    .info()
    .msg(
      'Deleting Prometheus alarms for instances with autoalarm:enabled set to false if they exist.',
    );
  if (prometheusWorkspaceId) {
    await batchPromRulesDeletion(
      prometheusWorkspaceId,
      deleteInstanceAlarmsArray,
      'ec2',
    );
  }
}

// TODO: add prom logic for this function as well.
export async function manageInactiveInstanceAlarms(
  inactiveInstancesInfoArray: EC2AlarmManagerArray,
) {
  const alarmsToDelete: string[] = [];
  for (const instanceInfo of inactiveInstancesInfoArray) {
    const existingAlarms: string[] = await getCWAlarmsForInstance(
      'EC2',
      instanceInfo.instanceID,
    );
    alarmsToDelete.push(...existingAlarms);
  }
  try {
    await cloudWatchClient.send(
      new DeleteAlarmsCommand({
        AlarmNames: alarmsToDelete,
      }),
    );
  } catch (e) {
    log
      .error()
      .str('function', 'manageInactiveInstanceAlarms')
      .err(e)
      .msg(`Error deleting alarms: ${e}`);
    throw new Error(`Error deleting alarms: ${e}`);
  }
}

export async function getEC2IdAndState(
  // TODO Fix the use of any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any,
): Promise<{instanceId: string; state: ValidInstanceState}> {
  const instanceId = event.resources[0].split('/').pop();
  log.info().str('resourceId', instanceId).msg('Processing tag event');

  const describeInstancesResponse = await ec2Client.send(
    new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    }),
  );
  const instance = describeInstancesResponse.Reservations?.[0]?.Instances?.[0];
  const state = instance?.State?.Name as ValidInstanceState;
  return {instanceId: instanceId, state: state};
}

export const liveStates: Set<ValidInstanceState> = new Set([
  ValidInstanceState.Running,
  //ValidInstanceState.Pending,
]);

export const deadStates: Set<ValidInstanceState> = new Set([
  ValidInstanceState.Terminated,
  //ValidInstanceState.Stopping, //for testing.
  //ValidInstanceState.Stopped, //for testing.
  //ValidInstanceState.ShuttingDown, //for testing.
]);
