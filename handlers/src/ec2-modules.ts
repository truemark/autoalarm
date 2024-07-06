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
import {Tag, PathMetrics} from './types'; //need to investigate what we were doing with Dimension.
import {
  doesAlarmExist,
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
  queryPrometheusForService,
  describeNamespace,
  managePromNamespaceAlarms,
  deletePromRulesForService,
} from './alarm-tools';

const log: logging.Logger = logging.getRootLogger();
async function loggingSetup() {
  try {
    await logging.initialize({
      svc: 'AutoAlarm',
      name: 'ec2-modules',
      level: 'trace',
    });
  } catch (error) {
    // Fallback logging initialization (e.g., to console)
    console.error('Failed to initialize custom logger:', error);
    throw new Error(`Failed to initialize custom logger: ${error}`);
  }
}
const ec2Client: EC2Client = new EC2Client({});
const cloudWatchClient: CloudWatchClient = new CloudWatchClient({});
//the follwing environment variables are used to get the prometheus workspace id and the region
const prometheusWorkspaceId: string = process.env.PROMETHEUS_WORKSPACE_ID || '';
const region: string = process.env.AWS_REGION || '';

//these vars are used in the prometheus alarm logic.
let shouldUpdatePromRules = false;
let shouldDeletePromAlarm = false;
let isCloudWatch = true;

async function batchPromRulesDeletion(
  shouldDeletePromAlarm: boolean,
  prometheusWorkspaceId: string,
  service: string
) {
  if (!shouldDeletePromAlarm) {
    log
      .info()
      .str('function', 'batchPromRulesDeletion')
      .str('shouldDeletePromAlarm', 'false')
      .msg('Prometheus rules have not been marked for deletion');
    return;
  }

  log
    .info()
    .str('function', 'batchPromRulesDeletion')
    .str('shouldDeletePromAlarm', 'true')
    .msg('Prometheus rules have been marked for deletion. Fetching instances.');

  const instanceIds = await getAllInstanceIdsInRegion();

  const instanceDetailsPromises = instanceIds.map(async instanceId => {
    const tags = await fetchInstanceTags(instanceId);
    return {instanceId, tags};
  });

  const instanceDetails = await Promise.all(instanceDetailsPromises);

  const instancesToDelete = instanceDetails
    .filter(
      details =>
        (details.tags['Prometheus'] === 'false' &&
          details.tags['autoalarm:disabled']) ||
        details.tags['autoalarm:disabled'] === 'true'
    )
    .map(details => details.instanceId);

  log
    .info()
    .str('function', 'batchPromRulesDeletion')
    .str('instancesToDelete', JSON.stringify(instancesToDelete))
    .msg('Instances to delete Prometheus rules for');

  // Delete Prometheus rules for all relevant instances at once
  try {
    await deletePromRulesForService(
      prometheusWorkspaceId,
      service,
      instancesToDelete
    );
  } catch (error) {
    log
      .error()
      .str('function', 'batchPromRulesDeletion')
      .err(error)
      .msg('Error deleting Prometheus rules');
  }
}

/**
 * Get alarm configurations for prometheus alarms. Specifically, for an instance based on its tags and classification.
 * @param instanceId - The EC2 instance ID.
 * @param tags - The tags associated with the EC2 instance.
 * @param classification - The alarm classification (e.g., CRITICAL, WARNING).
 * @returns Array of alarm configurations.
 */
async function getPromAlarmConfigs(
  instanceId: string,
  tags: Tag,
  classification: AlarmClassification
): Promise<any[]> {
  const configs = [];

  const {alarmName: cpuAlarmName, thresholdKey: cpuThresholdKey} =
    await getAlarmConfig(instanceId, classification, 'cpu');
  configs.push({
    instanceId,
    type: classification,
    alarmName: cpuAlarmName,
    alarmQuery: `100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > ${tags[cpuThresholdKey]}`,
    duration: '5m',
    severityType: classification.toLowerCase(),
  });

  const {alarmName: memAlarmName, thresholdKey: memThresholdKey} =
    await getAlarmConfig(instanceId, classification, 'memory');
  configs.push({
    instanceId,
    type: classification,
    alarmName: memAlarmName,
    alarmQuery: `100 - (avg by (instance) (rate(node_memory_MemAvailable_bytes[5m])) * 100) > ${tags[memThresholdKey]}`,
    duration: '5m',
    severityType: classification.toLowerCase(),
  });

  const {alarmName: storageAlarmName, thresholdKey: storageThresholdKey} =
    await getAlarmConfig(instanceId, classification, 'storage');
  configs.push({
    instanceId,
    type: classification,
    alarmName: storageAlarmName,
    alarmQuery: `100 - (avg by (instance) (rate(node_filesystem_avail_bytes{fstype!="tmpfs"}[5m])) * 100) > ${tags[storageThresholdKey]}`,
    duration: '5m',
    severityType: classification.toLowerCase(),
  });

  return configs;
}

/**
 * This function checks if a specific EC2 instance is reporting metrics to Prometheus.
 * It fetches the instance details and compares the instance's private IP against a list
 * of IPs currently reporting to Prometheus. If the instance is not reporting, the function
 * will retry the check-up to 8 times, with a 1-minute delay between each attempt.
 *
 * If after 8 attempts the instance is still not reporting to Prometheus, the function sets
 * the `isCloudWatch` flag to true, indicating that CloudWatch should be used for monitoring
 * instead of Prometheus.
 *
 * The purpose of this function is to ensure that instances that are expected to report to
 * Prometheus are given ample time and retries to start reporting before falling back to
 * CloudWatch for monitoring.
 *
 * @param {string} instanceId - The ID of the EC2 instance to check.
 * @param {string[]} reportingInstances - An array of IPs currently reporting to Prometheus.
 */

async function alarmFavor(instanceId: string) {
  const retryLimit = 96; //96 retries at 5 second intervals = 8 minutes
  const retryDelay = 5000; // 5 seconds in milliseconds

  let instanceIdEc2Metadata = await getInstanceDetails(instanceId);
  let TriggeredInstanceIP = instanceIdEc2Metadata.privateIp;

  for (let attempt = 0; attempt < retryLimit; attempt++) {
    const reportingInstances = await queryPrometheusForService(
      'ec2',
      prometheusWorkspaceId,
      region
    );
    log
      .info()
      .str('function', 'alarmFavor')
      .str('instanceIdMetadata', JSON.stringify(instanceIdEc2Metadata))
      .str('TriggeredInstanceIP', TriggeredInstanceIP)
      .str('reportingInstanceIps', JSON.stringify(reportingInstances))
      .num('attempt', attempt + 1)
      .msg('Fetched instance details and list of reporting instance IPs');

    if (reportingInstances.includes(TriggeredInstanceIP)) {
      log
        .info()
        .str('function', 'alarmFavor')
        .str('instanceId', instanceId)
        .str('reporting instances', JSON.stringify(reportingInstances))
        .str('TriggeredInstanceIP', TriggeredInstanceIP)
        .msg(
          'Instance is reporting to Prometheus. Setting isCloudWatch to false'
        );
      isCloudWatch = false;
      return;
    } else if (attempt < retryLimit - 1) {
      log
        .warn()
        .str('function', 'alarmFavor')
        .str('instanceId', instanceId)
        .str('TriggeredInstanceIP', TriggeredInstanceIP)
        .num('attempt', attempt + 1)
        .msg(
          'Instance is not reporting to Prometheus. Retrying after a 5 second delay'
        );
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      instanceIdEc2Metadata = await getInstanceDetails(instanceId);
      TriggeredInstanceIP = instanceIdEc2Metadata.privateIp;
    }
  }

  log
    .info()
    .str('function', 'alarmFavor')
    .str('instanceId', instanceId)
    .str('TriggeredInstanceIP', TriggeredInstanceIP)
    .msg(
      'Instance is not reporting to Prometheus after max retries. Setting isCloudWatch to true'
    );
  isCloudWatch = true;
}

/**
 * Function to get all EC2 instance IDs in the region.
 * @returns Array of EC2 instance IDs.
 */
async function getAllInstanceIdsInRegion(): Promise<string[]> {
  const command = new DescribeInstancesCommand({});
  const response = await ec2Client.send(command);
  const instanceIds: string[] = [];

  for (const reservation of response.Reservations || []) {
    for (const instance of reservation.Instances || []) {
      if (instance.InstanceId) {
        instanceIds.push(instance.InstanceId);
      }
    }
  }

  return instanceIds;
}

/**
 * Batch update Prometheus rules for all EC2 instances with the necessary tags and metrics reporting.
 * @param shouldUpdatePromRules - Boolean flag to indicate if Prometheus rules should be updated.
 * @param prometheusWorkspaceId - The Prometheus workspace ID.
 * @param service - The service name.
 * @param region - The AWS region passed by an environment variable.
 * @param instanceIds - Array of EC2 instance IDs.
 */
async function batchUpdatePromRules(
  shouldUpdatePromRules: boolean,
  prometheusWorkspaceId: string,
  service: string,
  region: string
) {
  const instanceIds = await getAllInstanceIdsInRegion();
  if (!shouldUpdatePromRules) {
    log
      .info()
      .str('function', 'batchUpdatePromRules')
      .str('shouldUpdatePromRules', 'false')
      .msg(
        'Prometheus rules have not been marked for update or creation. Skipping batch update.'
      );
    return;
  }

  const maxRetries = 60; // Maximum number of retries
  const retryDelay = 5000; // Delay between retries in milliseconds (5 seconds)
  const totalRetryTimeMinutes = (maxRetries * retryDelay) / 60000; // Total retry time in minutes

  let retryCount = 0;

  log
    .info()
    .str('function', 'batchUpdatePromRules')
    .str('instanceIds', JSON.stringify(instanceIds))
    .msg('Fetching instance details and tags');

  try {
    let instanceDetails = [];

    // Retry logic for fetching instance details and tags
    while (retryCount < maxRetries) {
      try {
        const instanceDetailsPromises = instanceIds.map(async instanceId => {
          const tags = await fetchInstanceTags(instanceId);
          const ec2Metadata = await getInstanceDetails(instanceId);
          return {instanceId, tags, privateIp: ec2Metadata.privateIp};
        });

        instanceDetails = await Promise.all(instanceDetailsPromises);

        log
          .info()
          .str('function', 'batchUpdatePromRules')
          .msg('Filtering instances based on tags');

        const instancesToCheck = instanceDetails.filter(
          details =>
            details.tags['Prometheus'] === 'true' &&
            details.tags['autoalarm:disabled'] === 'false'
        );

        log
          .info()
          .str('function', 'batchUpdatePromRules')
          .str('instancesToCheck', JSON.stringify(instancesToCheck))
          .msg('Instances to check for Prometheus rules');

        const reportingInstanceIps = await queryPrometheusForService(
          'ec2',
          prometheusWorkspaceId,
          region
        );

        const instancesToUpdate = instancesToCheck.filter(details =>
          reportingInstanceIps.includes(details.privateIp)
        );

        const alarmConfigs: any[] = [];
        for (const {instanceId, tags} of instancesToUpdate) {
          for (const classification of Object.values(AlarmClassification)) {
            const configs = await getPromAlarmConfigs(
              instanceId,
              tags,
              classification
            );
            alarmConfigs.push(...configs);
          }
        }

        log
          .info()
          .str('function', 'batchUpdatePromRules')
          .str('alarmConfigs', JSON.stringify(alarmConfigs))
          .msg('Consolidated alarm configurations');

        const namespace = `AutoAlarm-${service.toUpperCase()}`;
        const ruleGroupName = 'AutoAlarm';

        log
          .info()
          .str('function', 'batchUpdatePromRules')
          .msg(
            `Updating Prometheus rules for all instances in batch under namespace: ${namespace}`
          );

        await managePromNamespaceAlarms(
          prometheusWorkspaceId,
          namespace,
          ruleGroupName,
          alarmConfigs
        );

        log
          .info()
          .str('function', 'batchUpdatePromRules')
          .msg('Batch update of Prometheus rules completed.');

        await verifyNamespaceUpdate(prometheusWorkspaceId, namespace);
        break;
      } catch (error) {
        retryCount++;
        log
          .warn()
          .str('function', 'batchUpdatePromRules')
          .num('retryCount', retryCount)
          .msg(
            `Retry ${retryCount}/${maxRetries} failed. Retrying in ${retryDelay / 1000} seconds...`
          );

        if (retryCount >= maxRetries) {
          throw new Error(
            `Error during batch update of Prometheus rules after ${maxRetries} retries (${totalRetryTimeMinutes} minutes): ${error}`
          );
        }

        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  } catch (error) {
    log
      .error()
      .str('function', 'batchUpdatePromRules')
      .err(error)
      .msg('Error during batch update of Prometheus rules');
    throw new Error(`Error during batch update of Prometheus rules: ${error}`);
  }
}

async function verifyNamespaceUpdate(workspaceId: string, namespace: string) {
  try {
    const nsDetails = await describeNamespace(workspaceId, namespace);
    if (nsDetails) {
      log
        .info()
        .str('function', 'verifyNamespaceUpdate')
        .obj('namespace details', nsDetails)
        .msg('Namespace update verified');
    } else {
      log
        .warn()
        .str('function', 'verifyNamespaceUpdate')
        .msg('Namespace update verification failed');
    }
  } catch (error) {
    log
      .error()
      .str('function', 'verifyNamespaceUpdate')
      .err(error)
      .msg('Error verifying namespace update');
  }
}

// The following const and function are used to dynamically identify the alarm configuration tags and apply them to each alarm
// that requires those configurations. The default threshold is set to 90 for critical alarms and 80 for warning alarms.
// The manageActiveInstances function will call these alarm functions twice, once for each alarm classification type 'Critical' and 'Warning'.
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
    alarmName: `AutoAlarm-EC2-${instanceId}-${type}-${metric.toUpperCase()}-Utilization`,
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
          .str('function', 'getInstanceDetails')
          .err('No platform details found')
          .str('instanceId', instanceId)
          .msg('No platform details found');
        throw new Error('No platform details found');
      }
      return {platform, privateIp};
    } else {
      log
        .info()
        .str('function', 'getInstanceDetails')
        .str('instanceId', instanceId)
        .msg('No reservations found or no instances in reservation');
      return {platform: null, privateIp: ''};
    }
  } catch (error) {
    log
      .error()
      .str('function', 'getInstanceDetails')
      .err(error)
      .str('instanceId', instanceId)
      .msg('Failed to fetch instance details');
    return {platform: null, privateIp: ''};
  }
}

//this function is used to create the CloudWatch alarms for CPU, Memory, and Storage in addition to reducing redundant logic needed across those 3 functions
async function createCloudWatchAlarms(
  instanceId: string,
  alarmName: string,
  metricName: string,
  namespace: string,
  dimensions: any[],
  type: AlarmClassification,
  tags: Tag,
  thresholdKey: string,
  durationTimeKey: string,
  durationPeriodsKey: string
): Promise<void> {
  const alarmProps = {
    threshold: defaultThreshold(type),
    period: 60,
    namespace: namespace,
    evaluationPeriods: 5,
    metricName: metricName,
    dimensions: dimensions,
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

export async function manageCPUUsageAlarmForInstance(
  instanceId: string,
  tags: Tag,
  type: AlarmClassification,
  usePrometheus: boolean
): Promise<void> {
  const {alarmName, thresholdKey, durationTimeKey, durationPeriodsKey} =
    await getAlarmConfig(instanceId, type, 'cpu');
  //we should consolidate the promethues tag check and the iscloudwatch check into manage active isntances and instead pass a boolean to this function and create prom alarms based of that.
  if (usePrometheus) {
    log
      .info()
      .str('function', 'manageCPUUsageAlarmForInstance')
      .str('instanceId', instanceId)
      .str('Prometheus', tags['Prometheus'])
      .str('usePrometheus', usePrometheus.toString())
      .str('isCloudWatch', isCloudWatch.toString())
      .str('AlarmName', alarmName)
      .msg(
        'Prometheus Metrics being recieved from instance. Skipping CloudWatch alarm creation.'
      );
    return;
  } else {
    log
      .info()
      .str('function', 'manageCPUUsageAlarmForInstance')
      .str('prometheus tag', tags['Prometheus'])
      .str('instanceId', instanceId)
      .str('AlarmName', alarmName)
      .msg(
        'Prometheus tag set to false or metrics not being reported to Prometheus. Skipping prometheus rules and creating CW alarms.'
      );
    await createCloudWatchAlarms(
      instanceId,
      alarmName,
      'CPUUtilization',
      'AWS/EC2',
      [{Name: 'InstanceId', Value: instanceId}],
      type,
      tags,
      thresholdKey,
      durationTimeKey,
      durationPeriodsKey
    );
  }
}

export async function manageStorageAlarmForInstance(
  instanceId: string,
  tags: Tag,
  type: AlarmClassification,
  usePrometheus: boolean
): Promise<void> {
  const {
    alarmName,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey,
    ec2Metadata,
  } = await getAlarmConfig(instanceId, type, 'storage');
  const isWindows = ec2Metadata.platform
    ? ec2Metadata.platform.toLowerCase().includes('windows')
    : false;
  const metricName = isWindows
    ? 'LogicalDisk % Free Space'
    : 'disk_used_percent';
  if (usePrometheus) {
    log
      .info()
      .str('function', 'manageStorageAlarmForInstance')
      .str('instanceId', instanceId)
      .str('Prometheus', tags['Prometheus'])
      .str('usePrometheus', usePrometheus.toString())
      .str('isCloudWatch', isCloudWatch.toString())
      .msg(
        'Prometheus Metrics being recieved from instance. Skipping CloudWatch alarm creation.'
      );
    return;
  } else {
    log
      .info()
      .str('function', 'manageStorageAlarmForInstance')
      .str('AlarmName', alarmName)
      .str('prometheus tag', tags['Prometheus'])
      .str('instanceId', instanceId)
      .msg(
        'Prometheus tag set to false or metrics not being reported to Prometheus. Skipping prometheus rules and creating CW alarms.'
      );
    const storagePaths = await getStoragePathsFromCloudWatch(
      instanceId,
      metricName
    );
    const paths = Object.keys(storagePaths);
    if (paths.length > 0) {
      for (const path of paths) {
        const dimensions_props = storagePaths[path];
        const storageAlarmName = `${alarmName}-${path}`;
        log
          .info()
          .str('function', 'manageStorageAlarmForInstance')
          .str('instanceId', instanceId)
          .str('path', path)
          .str('storageAlarmName', storageAlarmName)
          .msg('Creating storage alarm');
        await createCloudWatchAlarms(
          instanceId,
          storageAlarmName,
          metricName,
          'CWAgent',
          dimensions_props,
          type,
          tags,
          thresholdKey,
          durationTimeKey,
          durationPeriodsKey
        );
      }
    } else {
      log
        .info()
        .str('function', 'manageStorageAlarmForInstance')
        .str('instanceId', instanceId)
        .msg(
          'CloudWatch metrics not found for storage paths. Skipping alarm creation.'
        );
    }
  }
}

export async function manageMemoryAlarmForInstance(
  instanceId: string,
  tags: Tag,
  type: AlarmClassification,
  usePrometheus: boolean
): Promise<void> {
  const {
    alarmName,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey,
    ec2Metadata,
  } = await getAlarmConfig(instanceId, type, 'memory');

  const isWindows = ec2Metadata.platform
    ? ec2Metadata.platform.toLowerCase().includes('windows')
    : false;
  const metricName = isWindows
    ? 'Memory % Committed Bytes In Use'
    : 'mem_used_percent';
  if (usePrometheus) {
    log
      .info()
      .str('function', 'manageMemoryAlarmForInstance')
      .str('instanceId', instanceId)
      .str('Prometheus', tags['Prometheus'])
      .str('usePrometheus', usePrometheus.toString())
      .str('isCloudWatch', isCloudWatch.toString())
      .str('AlarmName', alarmName)
      .msg(
        'Prometheus Metrics being recieved from instance. Skipping CloudWatch alarm creation.'
      );
    return;
  } else {
    log
      .info()
      .str('function', 'manageMemoryAlarmForInstance')
      .str('AlarmName', alarmName)
      .str('prometheus tag', tags['Prometheus'])
      .str('instanceId', instanceId)
      .str('AlarmName', alarmName)
      .msg(
        'Prometheus tag set to false or metrics not being reported to Prometheus. Skipping prometheus rules and creating CW alarms.'
      );
    await createCloudWatchAlarms(
      instanceId,
      alarmName,
      metricName,
      'CWAgent',
      [{Name: 'InstanceId', Value: instanceId}],
      type,
      tags,
      thresholdKey,
      durationTimeKey,
      durationPeriodsKey
    );
  }
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
  if (tags['autoalarm:disabled'] === 'true') {
    deleteCWAlarm(instanceId, 'StatusCheckFailed');
    log.info().msg('Status check alarm creation skipped due to tag settings.');
  } else if (tags['autoalarm:disabled'] === 'false') {
    // Create status check alarm if not disabled
    await createStatusAlarmForInstance(instanceId, doesAlarmExist);
  } else if (tags['autoalarm:disabled'] in tags) {
    log
      .warn()
      .str('function', 'checkAndManageStatusAlarm')
      .msg(
        'autoalarm:disabled tag exists but has unexpected value. checking for alarm and creating if it does not exist'
      );
    await createStatusAlarmForInstance(instanceId, doesAlarmExist);
  }
}

// Function used to call CPU, Memory, and Storage alarm functions for each instance that triggers the eventbridge rule
async function callAlarmFunctions(
  instanceId: string,
  tags: Tag,
  shouldUpdatePromRules: boolean
) {
  for (const classification of Object.values(AlarmClassification)) {
    try {
      await manageCPUUsageAlarmForInstance(
        instanceId,
        tags,
        classification,
        shouldUpdatePromRules
      );
      await manageStorageAlarmForInstance(
        instanceId,
        tags,
        classification,
        shouldUpdatePromRules
      );
      await manageMemoryAlarmForInstance(
        instanceId,
        tags,
        classification,
        shouldUpdatePromRules
      );
    } catch (e) {
      log
        .error()
        .err(e)
        .str('function', 'manageActiveInstanceAlarms')
        .msg('Error managing alarms for instance');
      throw new Error(`Error managing alarms for instance: ${e}`);
    }
  }
}

export async function manageActiveInstanceAlarms(
  instanceId: string,
  tags: Tag
) {
  await loggingSetup();
  // Reset flags so prior lambda runs don't carry over old values
  shouldDeletePromAlarm = false;
  shouldUpdatePromRules = false;
  isCloudWatch = true;
  log
    .info()
    .str('function', 'manageActiveInstanceAlarms')
    .str('instanceId', instanceId)
    .str('Prometheus', tags['Prometheus'])
    .msg('Checking Prometheus tag value before conditional check.');

  if (tags['Prometheus'] === 'true') {
    log
      .info()
      .str('function', 'manageActiveInstanceAlarms')
      .str('instanceId', instanceId)
      .str('Prometheus', tags['Prometheus'])
      .msg(
        'Instance is configured for Prometheus. Getting list of all instances reporting to Prometheus'
      );
    await alarmFavor(instanceId); // Sets isCloudWatch to false if reporting to Prometheus
  }

  await checkAndManageStatusAlarm(instanceId, tags);

  if (isCloudWatch !== true) {
    log
      .info()
      .str('function', 'manageActiveInstanceAlarms')
      .str('instanceId', instanceId)
      .bool('isCloudWatch', isCloudWatch)
      .str('Prometheus', tags['Prometheus'])
      .msg(
        'Instance that triggered eventbridge rule is configured for and reporting to Prometheus. Setting shouldUpdatePromRules flag to true.'
      );
    shouldUpdatePromRules = true;
  } else {
    log
      .info()
      .str('function', 'manageActiveInstanceAlarms')
      .str('instanceId', instanceId)
      .str('isCloudWatch', isCloudWatch.toString())
      .str('Prometheus', tags['Prometheus'])
      .msg(
        'Instance that triggered eventbridge rule is not configured for Prometheus. Setting shouldDeletePromAlarm flag to true.'
      );
    shouldDeletePromAlarm = true;
  }

  await callAlarmFunctions(instanceId, tags, shouldUpdatePromRules);

  if (shouldUpdatePromRules && !shouldDeletePromAlarm) {
    try {
      await batchUpdatePromRules(
        shouldUpdatePromRules,
        prometheusWorkspaceId,
        'ec2',
        region
      );
      log
        .info()
        .str('function', 'manageActiveInstanceAlarms')
        .str('instanceId', instanceId)
        .str('isCloudWatch', isCloudWatch.toString())
        .str('Prometheus', tags['Prometheus'])
        .msg(
          'Instance that triggered eventbridge rule is reporting to Prometheus. Deleting CloudWatch alarms for instance'
        );

      const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
        'EC2',
        instanceId
      );
      log
        .info()
        .str('function', 'manageActiveInstanceAlarms')
        .str('instanceId', instanceId)
        .obj('activeAutoAlarms', activeAutoAlarms)
        .msg('Grabbing all AutoAlarm CloudWatch alarms for instance.');

      // Filter out status check alarm from deletion as the status check alarm should always be live
      const filteredAutoAlarms = activeAutoAlarms.filter(
        alarm => !alarm.includes('StatusCheckFailed')
      );
      log
        .info()
        .str('function', 'manageActiveInstanceAlarms')
        .str('instanceId', instanceId)
        .obj('filteredAutoAlarms', filteredAutoAlarms)
        .msg(
          'Filtering out StatusCheckFailed alarm from deletion and deleting all other cloudwatch alarms.'
        );
      await Promise.all(
        filteredAutoAlarms.map(alarmName =>
          deleteCWAlarm(alarmName, instanceId)
        )
      );
    } catch (e) {
      shouldUpdatePromRules = false;
      shouldDeletePromAlarm = true;
      log
        .error()
        .str('instanceId', instanceId)
        .str('function', 'manageActiveInstanceAlarms')
        .err(e)
        .msg(
          'Error updating Prometheus rules for instances. Falling back to CW alarms. Setting shouldDeletePromAlarm' +
            'flag to true and shouldUpdatePromRules flag to false. Deleting Prometheus alarm rules for instance'
        );
      await callAlarmFunctions(instanceId, tags, shouldUpdatePromRules);
      // Here we delete just prom rules for the instance that triggered the eventbridge rule, so we don't try to update
      // en masse if there is a larger general issue. Subsequent runs will try to update again for other isntances.
      const promInstancesToDelete = [instanceId]; // we only want to delete the prometheus rules for the instance that failed to update
      await deletePromRulesForService(
        prometheusWorkspaceId,
        'ec2',
        promInstancesToDelete
      );
    }
    // If isCloudWatch is true, we will delete the prometheus rules for the instance
  } else {
    log
      .info()
      .str('function', 'manageActiveInstanceAlarms')
      .str('instanceId', instanceId)
      .str('isCloudWatch', isCloudWatch.toString())
      .str('Prometheus', tags['Prometheus'])
      .str('isCloudWatch', isCloudWatch.toString())
      .msg(
        'isCloudWatch is true. Deleting Prometheus alarm rules for instance'
      );
    shouldUpdatePromRules = false;
    await callAlarmFunctions(instanceId, tags, shouldUpdatePromRules);
    shouldDeletePromAlarm = true;
    await batchPromRulesDeletion(
      shouldDeletePromAlarm,
      prometheusWorkspaceId,
      'ec2'
    );
  }
}

export async function manageInactiveInstanceAlarms(instanceId: string) {
  await loggingSetup();
  shouldDeletePromAlarm = true;
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'EC2',
      instanceId
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName => deleteCWAlarm(alarmName, instanceId))
    );
    await batchPromRulesDeletion(
      shouldDeletePromAlarm, //this is a boolean that is set to true if any prometheus rules have been marked for deletion in favor of cloudwatch alarms
      prometheusWorkspaceId,
      'ec2'
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
