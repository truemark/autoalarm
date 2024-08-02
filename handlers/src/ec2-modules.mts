import {
  DescribeInstancesCommand,
  DescribeTagsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  ListMetricsCommand,
  PutMetricAlarmCommand,
  Statistic,
} from '@aws-sdk/client-cloudwatch';
import * as logging from '@nr1e/logging';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {AlarmClassification, ValidInstanceState} from './enums.mjs';
import {Tag, PathMetrics} from './types.mjs'; //need to investigate what we were doing with Dimension.
import {
  doesAlarmExist,
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
  queryPrometheusForService,
  managePromNamespaceAlarms,
  deletePromRulesForService,
  createOrUpdateAnomalyDetectionAlarm,
  MissingDataTreatment,
} from './alarm-tools.mjs';

const log: logging.Logger = logging.getLogger('ec2-modules');
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
//the follwing environment variables are used to get the prometheus workspace id and the region
const prometheusWorkspaceId: string = process.env.PROMETHEUS_WORKSPACE_ID || '';

//these vars are used in the prometheus alarm logic.
let shouldUpdatePromRules = false;
let shouldDeletePromAlarm = false;
let isCloudWatch = true;

/**
 * This funciton is used to delete all prom rules in batch for instances that have been marked for Prom rule deletion.
 * @param shouldDeletePromAlarm - boolean flag to indicate if prometheus rules should be deleted.
 * @param prometheusWorkspaceId - The prometheus workspace id.
 * @param service - The service name.
 */
async function batchPromRulesDeletion(
  shouldDeletePromAlarm: boolean,
  prometheusWorkspaceId: string,
  service: string
) {
  const retryLimit = 60; // 60 retries at 5-second intervals = 5 minutes
  const retryDelay = 5000; // 5 seconds in milliseconds

  if (!prometheusWorkspaceId) {
    log
      .info()
      .str('function', 'batchPromRulesDeletion')
      .msg(
        'Prometheus workspace ID not found. Skipping Prometheus rules deletion)'
      );
    return;
  } else if (!shouldDeletePromAlarm) {
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

  for (let attempt = 0; attempt < retryLimit; attempt++) {
    try {
      const instancesInfo = await getAllInstancesInfoInRegion();
      const instanceDetailsPromises = instancesInfo.map(
        async ({instanceId, state}) => {
          const tags = await fetchInstanceTags(instanceId);
          return {instanceId, tags, state};
        }
      );

      const instanceDetails = await Promise.all(instanceDetailsPromises);

      const instancesToDelete = instanceDetails
        .filter(details => {
          const baseCondition =
            details.tags['autoalarm:target'] === 'cloudwatch' ||
            details.tags['autoalarm:enabled'] === 'false';
          const isTerminating = ['terminated'].includes(details.state);

          return (
            baseCondition ||
            (details.tags['autoalarm:enabled'] && isTerminating)
          );
        })
        .map(details => details.instanceId);

      log
        .info()
        .str('function', 'batchPromRulesDeletion')
        .str('instancesToDelete', JSON.stringify(instancesToDelete))
        .msg('Instances to delete Prometheus rules for');

      if (instancesToDelete.length > 0) {
        // Delete Prometheus rules for all relevant instances at once
        await deletePromRulesForService(
          prometheusWorkspaceId,
          service,
          instancesToDelete
        );
        log
          .info()
          .str('function', 'batchPromRulesDeletion')
          .msg(
            'Prometheus rules deleted successfully in batch or no rules to delete'
          );
        break; // Exit loop if successful
      } else {
        log
          .info()
          .str('function', 'batchPromRulesDeletion')
          .msg('No instances found to delete Prometheus rules for');
        break; //break loop if no instances found
      }
    } catch (error) {
      log
        .error()
        .str('function', 'batchPromRulesDeletion')
        .err(error)
        .num('attempt', attempt + 1)
        .msg('Error deleting Prometheus rules. Trying again in 5 seconds...');

      if (attempt < retryLimit - 1) {
        log
          .warn()
          .str('function', 'batchPromRulesDeletion')
          .num('attempt', attempt + 1)
          .msg(
            `Retry ${attempt + 1}/${retryLimit} failed. Retrying after a 5-second delay...`
          );
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        log
          .error()
          .str('function', 'batchPromRulesDeletion')
          .msg(
            `Error deleting Prometheus rules after ${retryLimit} retries. Please investigate.`
          );
      }
    }
  }
}

/**
 * Get alarm configurations for prometheus alarms. Specifically, for an instance based on its tags and classification.
 * @param instanceId - The EC2 instance ID.
 * @param classification - The alarm classification (e.g., CRITICAL, WARNING).
 * @returns Array of alarm configurations.
 */
async function getPromAlarmConfigs(
  instanceId: string,
  classification: AlarmClassification
): Promise<any[]> {
  const configs = [];
  const tags = await fetchInstanceTags(instanceId);
  const {
    staticThresholdAlarmName: cpuAlarmName,
    threshold: cpuThreshold,
    durationStaticTime: cpuDurationTime,
    ec2Metadata: {platform, privateIp},
  } = await getAlarmConfig(instanceId, classification, 'cpu', tags);
  let escapedPrivateIp = '';

  log
    .info()
    .str('function', 'getPromAlarmConfigs')
    .str('instanceId', instanceId)
    .str('classification', classification)
    .str('alarmName', cpuAlarmName)
    .num('threshold', cpuThreshold)
    .num('durationTime', cpuDurationTime)
    .str('platform', platform as string)
    .str('privateIp', privateIp as string)
    .msg('Fetched alarm configuration');

  if (privateIp === '' || privateIp === null) {
    log
      .error()
      .str('function', 'getPromAlarmConfigs')
      .str('instanceId', instanceId)
      .msg('Private IP address not found for instance');
    throw new Error('Private IP address not found for instance');
  } else {
    escapedPrivateIp = privateIp.replace(/\./g, '\\\\.');
  }

  const cpuQuery = platform?.toLowerCase().includes('windows')
    ? `100 - (rate(windows_cpu_time_total{instance=~"(${escapedPrivateIp}.*|${instanceId})", mode="idle"}[30s]) * 100) > ${cpuThreshold}`
    : `100 - (rate(node_cpu_seconds_total{mode="idle", instance=~"(${escapedPrivateIp}.*|${instanceId})"}[30s]) * 100) > ${cpuThreshold}`;

  configs.push({
    instanceId,
    type: classification,
    alarmName: cpuAlarmName,
    alarmQuery: cpuQuery,
    duration: `${Math.floor(cpuDurationTime / 60)}m`, // Ensuring whole numbers for duration
    severityType: classification.toLowerCase(),
  });

  const {
    staticThresholdAlarmName: memAlarmName,
    threshold: memThreshold,
    durationStaticTime: memDurationTime,
  } = await getAlarmConfig(instanceId, classification, 'memory', tags);

  log
    .info()
    .str('function', 'getPromAlarmConfigs')
    .str('instanceId', instanceId)
    .str('classification', classification)
    .str('alarmName', memAlarmName)
    .num('threshold', memThreshold)
    .num('durationTime', memDurationTime)
    .str('platform', platform as string)
    .str('privateIp', privateIp as string)
    .msg('Fetched alarm configuration');

  const memQuery = platform?.toLowerCase().includes('windows')
    ? `100 - ((windows_os_virtual_memory_free_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})",job="ec2"} / windows_os_virtual_memory_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})",job="ec2"}) * 100) > ${memThreshold}`
    : `100 - ((node_memory_MemAvailable_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"} / node_memory_MemTotal_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"}) * 100) > ${memThreshold}`;

  configs.push({
    instanceId,
    type: classification,
    alarmName: memAlarmName,
    alarmQuery: memQuery,
    duration: `${Math.floor(memDurationTime / 60)}m`, // Ensuring whole numbers for duration
    severityType: classification.toLowerCase(),
  });

  const {
    staticThresholdAlarmName: storageAlarmName,
    threshold: storageThreshold,
    durationStaticTime: storageDurationTime,
  } = await getAlarmConfig(instanceId, classification, 'storage', tags);

  log
    .info()
    .str('function', 'getPromAlarmConfigs')
    .str('instanceId', instanceId)
    .str('classification', classification)
    .str('alarmName', storageAlarmName)
    .num('threshold', storageThreshold)
    .num('durationTime', storageDurationTime)
    .str('platform', platform as string)
    .str('privateIp', privateIp as string)
    .msg('Fetched alarm configuration');

  const storageQuery = platform?.toLowerCase().includes('windows')
    ? `100 - ((windows_logical_disk_free_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"} / windows_logical_disk_size_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"}) * 100) > ${storageThreshold}`
    : `100 - ((node_filesystem_free_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"} / node_filesystem_size_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"}) * 100) > ${storageThreshold}`;

  configs.push({
    instanceId,
    type: classification,
    alarmName: storageAlarmName,
    alarmQuery: storageQuery,
    duration: `${Math.floor(storageDurationTime / 60)}m`, // Ensuring whole numbers for duration
    severityType: classification.toLowerCase(),
  });

  return configs;
}

/**
 * Function to get all EC2 instance IDs in the region.
 * @returns Array of EC2 instance IDs.
 */
interface InstanceInfo {
  instanceId: string;
  state: string;
}
async function getAllInstancesInfoInRegion(): Promise<InstanceInfo[]> {
  const command = new DescribeInstancesCommand({});
  const response = await ec2Client.send(command);
  const instancesInfo: InstanceInfo[] = [];

  for (const reservation of response.Reservations || []) {
    for (const instance of reservation.Instances || []) {
      if (instance.InstanceId && instance.State && instance.State.Name) {
        instancesInfo.push({
          instanceId: instance.InstanceId,
          state: instance.State.Name,
        });
      }
    }
  }

  return instancesInfo;
}

/**
 * Batch update Prometheus rules for all EC2 instances with the necessary tags and metrics reporting.
 * @param shouldUpdatePromRules - Boolean flag to indicate if Prometheus rules should be updated.
 * @param prometheusWorkspaceId - The Prometheus workspace ID.
 * @param service - The service name.
 * @param region - The AWS region passed by an environment variable.
 */
async function batchUpdatePromRules(
  shouldUpdatePromRules: boolean,
  prometheusWorkspaceId: string,
  service: string,
  region: string
) {
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
    .msg('Fetching instance details and tags');

  try {
    let instanceDetails = [];

    // Retry logic for fetching instance details and tags
    while (retryCount < maxRetries) {
      try {
        const instancesInfo = await getAllInstancesInfoInRegion();
        const instanceDetailsPromises = instancesInfo.map(
          async ({instanceId, state}) => {
            const tags = await fetchInstanceTags(instanceId);
            const ec2Metadata = await getInstanceDetails(instanceId);
            return {instanceId, state, tags, privateIp: ec2Metadata.privateIp};
          }
        );

        instanceDetails = await Promise.all(instanceDetailsPromises);

        log
          .info()
          .str('function', 'batchUpdatePromRules')
          .msg('Filtering instances based on tags');

        const instancesToCheck = instanceDetails.filter(
          details =>
            details.tags['autoalarm:enabled'] &&
            details.tags['autoalarm:enabled'] !== 'false'
        );

        if (instancesToCheck.length === 0) {
          log
            .error()
            .str('function', 'batchUpdatePromRules')
            .str('instancesToCheck', JSON.stringify(instancesToCheck))
            .msg(
              'No instances found with autoalarm:enabled tag set to true. Verify BatchUpdatePromRules logic and manageActiveInstanceAlarms function.'
            );
          throw new Error(
            'No instances found with autoalarm:enabled tag set to true. Verify BatchUpdatePromRules logic and manageActiveInstanceAlarms function.'
          );
        }

        log
          .info()
          .str('function', 'batchUpdatePromRules')
          .str('instancesToCheck', JSON.stringify(instancesToCheck))
          .msg('Instances to check for Prometheus rules');
        // Use query Prometheus to get a list of instance label values between private IP addrs and Instance IDs depending on prom instance label configuration
        const reportingInstances = await queryPrometheusForService(
          'ec2',
          prometheusWorkspaceId,
          region
        );

        const instancesToUpdate = instancesToCheck.filter(
          details =>
            reportingInstances.includes(details.privateIp) ||
            reportingInstances.includes(details.instanceId)
        );

        if (instancesToCheck.length === 0) {
          log
            .error()
            .str('function', 'batchUpdatePromRules')
            .str('instancesToCheck', JSON.stringify(instancesToCheck))
            .num('retryCount', retryCount)
            .msg(
              `Retry ${retryCount}/${maxRetries} failed. Retrying in ${retryDelay / 1000} seconds...`
            );
          throw new Error(
            'No instances found with autoalarm:enabled tag set to true. Verify BatchUpdatePromRules logic and manageActiveInstanceAlarms function.'
          );
        }

        log
          .info()
          .str('function', 'batchUpdatePromRules')
          .str('instancesToUpdate', JSON.stringify(instancesToUpdate))
          .msg('Instances to update Prometheus rules for');

        const alarmConfigs: any[] = [];
        for (const {instanceId} of instancesToUpdate) {
          for (const classification of Object.values(AlarmClassification)) {
            const configs = await getPromAlarmConfigs(
              instanceId,
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
        break;
      } catch (error) {
        retryCount++;
        log
          .warn()
          .str('function', 'batchUpdatePromRules')
          .num('retryCount', retryCount)
          .str('error', error as string)
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

// The following const and function are used to dynamically identify the alarm configuration tags and apply them to each alarm
// that requires those configurations. The default threshold is set to 90 for critical alarms and 80 for warning alarms.
// The manageActiveInstances function will call these alarm functions twice, once for each alarm classification type 'Critical' and 'Warning'.
const defaultCPUThreshold = (type: AlarmClassification) =>
  type === 'CRITICAL' ? 98 : 95;
const defaultMemoryThreshold = (type: AlarmClassification) =>
  type === 'CRITICAL' ? 98 : 96;

const defaultStorageThreshold = (type: AlarmClassification) =>
  type === 'CRITICAL' ? 98 : 96;

// Default values for duration and periods
const defaultCPUStaticDurationTime = 300; // e.g., 300 seconds
const defaultCPUStaticDurationPeriods = 2; // e.g., 5 periods
const defaultStaticCPUSStatistic = 'p90';
const defaultStorageStaticDurationTime = 300; // e.g., 300 seconds
const defaultStorageStaticDurationPeriods = 2; // e.g., 5 periods
const defaultStaticStorageStatistic = 'Maximum';
const defaultMemoryStaticDurationTime = 300; // e.g., 300 seconds
const defaultMemoryStaticDurationPeriods = 2; // e.g., 5 periods
const defaultStaticMemoryStatistic = 'p90';
const defaultAnomalyDurationTime = 60; // e.g., 300 seconds
const defaultAnomalyDurationPeriods = 2; // e.g., 5 periods
const defaultExtendedStatistic: string = 'p90';
// used as input validation for extended statistics
const extendedStatRegex = /^\(p\d{1,2}\)$/;

async function getAlarmConfig(
  instanceId: string,
  type: AlarmClassification,
  metricTagName: string,
  tags: Tag
): Promise<{
  staticThresholdAlarmName: string;
  anomalyAlarmName: string;
  extendedStatistic: string;
  threshold: any;
  durationStaticTime: number;
  durationStaticPeriods: number;
  staticStatistic: string;
  durationAnomalyTime: number;
  durationAnomalyPeriods: number;
  useAnomalyDetection: boolean;
  ec2Metadata: {platform: string | null; privateIp: string | null};
}> {
  log
    .info()
    .str('function', 'getAlarmConfig')
    .str('instanceId', instanceId)
    .str('type', type)
    .str('metric', metricTagName)
    .msg('Fetching alarm configuration');

  // Initialize variables with default values
  let threshold: any;
  let durationStaticTime: number;
  let durationStaticPeriods: number;
  let staticStatistic: string;
  let useAnomalyDetection: boolean = false;

  switch (metricTagName) {
    case 'cpu':
      threshold = defaultCPUThreshold(type);
      durationStaticTime = defaultCPUStaticDurationTime;
      durationStaticPeriods = defaultCPUStaticDurationPeriods;
      staticStatistic = defaultStaticCPUSStatistic;
      break;
    case 'storage':
      threshold = defaultStorageThreshold(type);
      durationStaticTime = defaultStorageStaticDurationTime;
      durationStaticPeriods = defaultStorageStaticDurationPeriods;
      staticStatistic = defaultStaticStorageStatistic;
      break;
    case 'memory':
      threshold = defaultMemoryThreshold(type);
      durationStaticTime = defaultMemoryStaticDurationTime;
      durationStaticPeriods = defaultMemoryStaticDurationPeriods;
      staticStatistic = defaultStaticMemoryStatistic;
      break;
    default:
      throw new Error(`Unsupported metricTagName: ${metricTagName}`);
  }

  let extendedStatistic = defaultExtendedStatistic;
  let durationAnomalyTime = defaultAnomalyDurationTime;
  let durationAnomalyPeriods = defaultAnomalyDurationPeriods;
  const ec2Metadata = await getInstanceDetails(instanceId);
  log
    .info()
    .str('function', 'getAlarmConfig')
    .str('instanceId', instanceId)
    .msg('Fetching alarm configuration');

  // Define tag key based on metric
  const cwTagKey = `autoalarm:ec2-${metricTagName}`;
  const anomalyTagKey = `autoalarm:ec2-${metricTagName}-anomaly`;

  log
    .info()
    .str('function', 'getAlarmConfig')
    .str('instanceId', instanceId)
    .str('tags', JSON.stringify(tags))
    .str('tagKey', cwTagKey)
    .str('tagValue', tags[cwTagKey])
    .msg('Fetched instance tags');

  // Extract and parse the tag value
  if (tags[cwTagKey]) {
    const staticValues = tags[cwTagKey].split('/');
    log
      .info()
      .str('function', 'getAlarmConfig')
      .str('instanceId', instanceId)
      .str('tagKey', cwTagKey)
      .str('tagValue', tags[cwTagKey])
      .str('staticValues', JSON.stringify(staticValues))
      .msg('Fetched Static Threshold tag values');

    if (staticValues.length < 1 || staticValues.length > 5) {
      log
        .warn()
        .str('function', 'getAlarmConfig')
        .str('instanceId', instanceId)
        .str('tagKey', cwTagKey)
        .str('tagValue', tags[cwTagKey])
        .msg(
          'Invalid tag values/delimiters. Please use 4 values separated by a "/". Using default values'
        );
    } else {
      switch (type) {
        case 'WARNING':
          threshold =
            staticValues[0] !== undefined &&
            staticValues[0] !== '' &&
            !isNaN(parseInt(staticValues[0], 10))
              ? parseInt(staticValues[0], 10)
              : threshold;
          durationStaticTime =
            staticValues[2] !== undefined &&
            staticValues[2] !== '' &&
            !isNaN(parseInt(staticValues[2], 10))
              ? parseInt(staticValues[2], 10)
              : durationStaticTime;
          durationStaticPeriods =
            staticValues[3] !== undefined &&
            staticValues[3] !== '' &&
            !isNaN(parseInt(staticValues[3], 10))
              ? parseInt(staticValues[3], 10)
              : durationStaticPeriods;
          if (
            staticValues[4] !== undefined &&
            staticValues[4] !== '' &&
            Object.values(Statistic).includes(staticValues[4] as Statistic)
          ) {
            staticStatistic = staticValues[4];
          } else if (
            staticValues[4] !== undefined &&
            staticValues[4] !== '' &&
            !Object.values(Statistic).includes(staticValues[4] as Statistic) &&
            extendedStatRegex.test(staticValues[4])
          ) {
            extendedStatistic = staticValues[4];
          } else {
            staticValues[4] = staticStatistic;
          }
          break;
        case 'CRITICAL':
          threshold =
            staticValues[1] !== undefined &&
            staticValues[1] !== '' &&
            !isNaN(parseInt(staticValues[1], 10))
              ? parseInt(staticValues[1], 10)
              : threshold;
          durationStaticTime =
            staticValues[2] !== undefined &&
            staticValues[2] !== '' &&
            !isNaN(parseInt(staticValues[2], 10))
              ? parseInt(staticValues[2], 10)
              : durationStaticTime;
          durationStaticPeriods =
            staticValues[3] !== undefined &&
            staticValues[3] !== '' &&
            !isNaN(parseInt(staticValues[3], 10))
              ? parseInt(staticValues[3], 10)
              : durationStaticPeriods;
          if (
            staticValues[4] !== undefined &&
            staticValues[4] !== '' &&
            Object.values(Statistic).includes(staticValues[4] as Statistic)
          ) {
            staticStatistic = staticValues[4];
          } else if (
            staticValues[4] !== undefined &&
            staticValues[4] !== '' &&
            !Object.values(Statistic).includes(staticValues[4] as Statistic) &&
            extendedStatRegex.test(staticValues[4])
          ) {
            extendedStatistic = staticValues[4];
          } else {
            staticValues[4] = staticStatistic;
          }
          break;
      }
    }
  }

  if (tags[anomalyTagKey]) {
    const values = tags[anomalyTagKey].split('/');
    const extendedStatRegex = /^\(p\d{1,2}\)$/;
    if (!extendedStatRegex.test(values[0].trim())) {
      log
        .warn()
        .str('function', 'getAlarmConfig')
        .str('instanceId', instanceId)
        .str('tagKey', anomalyTagKey)
        .str('tagValue', tags[anomalyTagKey])
        .msg(
          "Invalid extended statistic value. Please use a valid percentile value. Using default value of 'p90'"
        );
      values[0] = defaultExtendedStatistic;
    }
    log
      .info()
      .str('function', 'getAlarmConfig')
      .str('instanceId', instanceId)
      .str('tagKey', anomalyTagKey)
      .str('tagValue', tags[anomalyTagKey])
      .str('values', JSON.stringify(values))
      .msg('Fetched Anomaly Detection tag values');

    if (values.length < 1 || values.length > 3) {
      log
        .warn()
        .str('function', 'getAlarmConfig')
        .str('instanceId', instanceId)
        .str('tagKey', anomalyTagKey)
        .str('tagValue', tags[anomalyTagKey])
        .msg(
          'Invalid tag values/delimiters. Please use 3 values separated by a "|". Using default values'
        );
    } else {
      useAnomalyDetection = true;
      extendedStatistic =
        typeof values[0] === 'string' && values[0].trim() !== ''
          ? values[0].trim()
          : defaultExtendedStatistic;
      durationAnomalyTime =
        values[1] !== undefined &&
        values[1] !== '' &&
        !isNaN(parseInt(values[1], 10))
          ? parseInt(values[1], 10)
          : defaultAnomalyDurationTime;
      durationAnomalyPeriods =
        values[2] !== undefined &&
        values[2] !== '' &&
        !isNaN(parseInt(values[2], 10))
          ? parseInt(values[2], 10)
          : defaultAnomalyDurationPeriods;
      log
        .info()
        .str('function', 'getAlarmConfig')
        .str('instanceId', instanceId)
        .str('tagKey', anomalyTagKey)
        .str('tagValue', tags[anomalyTagKey])
        .str('extendedStatistic', extendedStatistic)
        .num('durationTime', durationAnomalyTime)
        .num('durationPeriods', durationAnomalyPeriods)
        .msg('Fetched Anomaly Detection tag values');
    }
  }
  log
    .info()
    .str('function', 'getAlarmConfig')
    .str('instanceId', instanceId)
    .str('type', type)
    .str('metricTagName', metricTagName)
    .str(
      'staticThresholdAlarmName',
      `AutoAlarm-EC2-StaticThreshold-${instanceId}-${type}-${metricTagName.toUpperCase()}-Utilization`
    )
    .str(
      'anomalyAlarmName',
      `AutoAlarm-EC2-AnomalyDetection-${instanceId}-CRITICAL-${metricTagName.toUpperCase()}-Utilization`
    )
    .str('extendedStatistic', extendedStatistic)
    .num('threshold', threshold)
    .num('durationStaticTime', durationStaticTime)
    .num('durationStaticPeriods', durationStaticPeriods)
    .num('durationAnomalyTime', durationAnomalyTime)
    .num('durationAnomalyPeriods', durationAnomalyPeriods)
    .str('ec2Metadata', JSON.stringify(ec2Metadata))
    .msg('Fetched alarm configuration');
  return {
    staticThresholdAlarmName: `AutoAlarm-EC2-StaticThreshold-${instanceId}-${type}-${metricTagName.toUpperCase()}-Utilization`,
    anomalyAlarmName: `AutoAlarm-EC2-AnomalyDetection-${instanceId}-CRITICAL-${metricTagName.toUpperCase()}-Utilization`,
    extendedStatistic,
    threshold,
    durationStaticTime,
    durationStaticPeriods,
    staticStatistic,
    durationAnomalyTime,
    durationAnomalyPeriods,
    useAnomalyDetection,
    ec2Metadata,
  };
}

// This function is used to confirm that memory metrics are being reported for an instance
async function getMemoryMetricsFromCloudWatch(
  instanceId: string,
  metricName: string
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
    if (
      path &&
      !path.startsWith('/snap') &&
      !path.startsWith('/run') &&
      !path.startsWith('/dev/shm') &&
      !path.startsWith('/boot')
    ) {
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

/**this function is used to create the CloudWatch alarms for CPU, Memory, and Storage in addition to reducing redundant logic needed across those 3 functions
 * This function is used to create the CloudWatch alarms for CPU, Memory, and Storage
 * in addition to reducing redundant logic needed across those 3 functions
 */

//type Statistic = 'Average' | 'Sum' | 'Minimum' | 'Maximum';
async function createCloudWatchAlarms(
  instanceId: string,
  alarmName: string,
  metricName: string,
  namespace: string,
  dimensions: any[],
  threshold: number,
  durationTime: number,
  durationPeriods: number,
  severityType: AlarmClassification,
  missingDataTreatment: MissingDataTreatment = 'ignore',
  statistic?: Statistic,
  extendedStatistic?: string
): Promise<void> {
  const alarmProps = {
    threshold: threshold,
    period: 60, //TODO: should not be hardcoded
    namespace: namespace,
    evaluationPeriods: durationPeriods,
    metricName: metricName,
    dimensions: dimensions,
  };

  await createOrUpdateCWAlarm(
    alarmName,
    instanceId,
    alarmProps,
    threshold,
    durationTime,
    durationPeriods,
    severityType,
    missingDataTreatment,
    statistic,
    extendedStatistic
  );
}

export async function manageCPUUsageAlarmForInstance(
  instanceId: string,
  tags: Tag,
  type: AlarmClassification,
  usePrometheus: boolean
): Promise<void> {
  const {
    staticThresholdAlarmName,
    anomalyAlarmName,
    extendedStatistic,
    threshold,
    durationStaticTime,
    durationStaticPeriods,
    staticStatistic,
    durationAnomalyTime,
    durationAnomalyPeriods,
    useAnomalyDetection,
  } = await getAlarmConfig(instanceId, type, 'cpu', tags);

  if (usePrometheus) {
    log
      .info()
      .str('function', 'manageCPUUsageAlarmForInstance')
      .str('instanceId', instanceId)
      .str('autoalarm:target', tags['autoalarm:target'])
      .str('usePrometheus', usePrometheus.toString())
      .str('Static Threshold AlarmName', staticThresholdAlarmName)
      .msg(
        'autoalarm:target set to prometheus. Skipping CloudWatch alarm creation.'
      );
    return;
  } else {
    log
      .info()
      .str('function', 'manageCPUUsageAlarmForInstance')
      .str('autoalarm:target', tags['autoalarm:target'])
      .str('instanceId', instanceId)
      .str('Static Threshold Alarm Name', staticThresholdAlarmName)
      .str('Anomaly Alarm Name', anomalyAlarmName)
      .msg(
        'autoalarm:target tag set to cloudwatch. Skipping prometheus rules and creating CW alarms.'
      );

    if (useAnomalyDetection) {
      await createOrUpdateAnomalyDetectionAlarm(
        anomalyAlarmName,
        'InstanceId',
        instanceId,
        'CPUUtilization',
        'AWS/EC2',
        extendedStatistic,
        durationAnomalyTime,
        durationAnomalyPeriods,
        'CRITICAL' as AlarmClassification
      );
    }
  }

  if (
    type === 'WARNING' &&
    (tags['autoalarm:ec2-cpu'].split('/')[0] === 'disabled' ||
      tags['autoalarm:ec2-cpu'].split('/')[0] === '-')
  ) {
    log
      .info()
      .str('function', 'manageCPUUsageAlarmForInstance')
      .str('instanceId', instanceId)
      .str('autoalarm:ec2-cpu', tags['autoalarm:ec2-cpu'])
      .msg(
        'CPU alarm threshold for warning is set to be disabled. Skipping static cpu warning alarm creation.'
      );
    await deleteCWAlarm(staticThresholdAlarmName, instanceId);
    return;
  } else if (
    type === 'CRITICAL' &&
    (tags['autoalarm:ec2-cpu'].split('/')[1] === 'disabled' ||
      tags['autoalarm:ec2-cpu'].split('/')[1] === '-')
  ) {
    log
      .info()
      .str('function', 'manageCPUUsageAlarmForInstance')
      .str('instanceId', instanceId)
      .str('autoalarm:ec2-cpu', tags['autoalarm:ec2-cpu'])
      .msg(
        'CPU alarm threshold for critical is not defined. Skipping static cpu critical alarm creation.'
      );
    await deleteCWAlarm(staticThresholdAlarmName, instanceId);
    return;
  }

  // using regex to validate the statistic type between statistic and extended statistic
  if (extendedStatRegex.test(staticStatistic)) {
    await createCloudWatchAlarms(
      instanceId,
      staticThresholdAlarmName,
      'CPUUtilization',
      'AWS/EC2',
      [{Name: 'InstanceId', Value: instanceId}],
      threshold,
      durationStaticTime,
      durationStaticPeriods,
      type,
      'ignore' as MissingDataTreatment,
      undefined,
      staticStatistic
    );
  } else {
    await createCloudWatchAlarms(
      instanceId,
      staticThresholdAlarmName,
      'CPUUtilization',
      'AWS/EC2',
      [{Name: 'InstanceId', Value: instanceId}],
      threshold,
      durationStaticTime,
      durationStaticPeriods,
      type,
      'ignore' as MissingDataTreatment,
      staticStatistic as Statistic,
      undefined
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
    staticThresholdAlarmName,
    anomalyAlarmName,
    extendedStatistic,
    threshold,
    durationStaticTime,
    durationStaticPeriods,
    staticStatistic,
    durationAnomalyTime,
    durationAnomalyPeriods,
    useAnomalyDetection,
    ec2Metadata,
  } = await getAlarmConfig(instanceId, type, 'storage', tags);
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
      .str('autoalarm:target', tags['autoalarm:target'])
      .str('usePrometheus', usePrometheus.toString())
      .str('isCloudWatch', isCloudWatch.toString())
      .msg(
        'Autoalarm:target set to prometheus. Skipping CloudWatch alarm creation.'
      );
    return;
  } else {
    log
      .info()
      .str('function', 'manageStorageAlarmForInstance')
      .str('autoalarm:target', tags['autoalarm:target'])
      .str('instanceId', instanceId)
      .msg(
        'autoalaram:target tag set to cloudwatch. Skipping prometheus rules and creating CW alarms.'
      );
    const storagePaths = await getStoragePathsFromCloudWatch(
      instanceId,
      metricName
    );
    let staticThresholdStorageAlarmName = '';
    let anomalyStorageAlarmName = '';
    const paths = Object.keys(storagePaths);
    if (paths.length > 0) {
      for (const path of paths) {
        const dimensions_props = storagePaths[path];
        staticThresholdStorageAlarmName = `${staticThresholdAlarmName}-${path}`;
        anomalyStorageAlarmName = `${anomalyAlarmName}-${path}`;

        if (useAnomalyDetection) {
          await createOrUpdateAnomalyDetectionAlarm(
            anomalyStorageAlarmName,
            'InstanceId',
            instanceId,
            metricName,
            'CWAgent',
            extendedStatistic,
            durationAnomalyTime,
            durationAnomalyPeriods,
            'CRITICAL' as AlarmClassification
          );
          log
            .info()
            .str('function', 'manageStorageAlarmForInstance')
            .str('instanceId', instanceId)
            .str('path', path)
            .msg('Creating Anomaly storage alarm');
        }
        if (
          type === 'WARNING' &&
          (tags['autoalarm:ec2-storage'].split('/')[0] === 'disabled' ||
            tags['autoalarm:ec2-storage'].split('/')[0] === '-')
        ) {
          log
            .info()
            .str('function', 'manageStorageAlarmForInstance')
            .str('alarmName', staticThresholdStorageAlarmName)
            .str('instanceId', instanceId)
            .str('autoalarm:cw-ec2-storage', tags['autoalarm:cw-ec2-storage'])
            .msg(
              'Storage alarm threshold for warning is not defined. Skipping static storage warning alarm creation. And deleting if they exist.'
            );
          await deleteCWAlarm(staticThresholdStorageAlarmName, instanceId);
        } else if (
          type === 'CRITICAL' &&
          (tags['autoalarm:ec2-storage'].split('/')[1] === 'disabled' ||
            tags['autoalarm:ec2-storage'].split('/')[1] === '-')
        ) {
          log
            .info()
            .str('function', 'manageStorageAlarmForInstance')
            .str('alarmName', staticThresholdStorageAlarmName)
            .str('instanceId', instanceId)
            .str('autoalarm:cw-ec2-storage', tags['autoalarm:cw-ec2-storage'])
            .msg(
              'Storage alarm threshold for critical is not defined. Skipping static storage critical alarm creation. And deleting if they exist.'
            );
          await deleteCWAlarm(staticThresholdStorageAlarmName, instanceId);
        } else {
          if (extendedStatRegex.test(extendedStatistic)) {
            await createCloudWatchAlarms(
              instanceId,
              staticThresholdStorageAlarmName,
              metricName,
              'CWAgent',
              dimensions_props,
              threshold,
              durationStaticTime,
              durationStaticPeriods,
              type,
              'ignore' as MissingDataTreatment,
              undefined,
              staticStatistic
            );
          } else {
            await createCloudWatchAlarms(
              instanceId,
              staticThresholdStorageAlarmName,
              metricName,
              'CWAgent',
              dimensions_props,
              threshold,
              durationStaticTime,
              durationStaticPeriods,
              type,
              'ignore' as MissingDataTreatment,
              staticStatistic as Statistic,
              undefined
            );
          }
        }
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
    staticThresholdAlarmName,
    anomalyAlarmName,
    extendedStatistic,
    threshold,
    durationStaticTime,
    durationStaticPeriods,
    staticStatistic,
    durationAnomalyTime,
    durationAnomalyPeriods,
    useAnomalyDetection,
    ec2Metadata,
  } = await getAlarmConfig(instanceId, type, 'memory', tags);

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
      .str('autoalarm:target', tags['autoalarm:target'])
      .str('usePrometheus', usePrometheus.toString())
      .str('isCloudWatch', isCloudWatch.toString())
      .msg(
        'Prometheus Metrics being recieved from instance. Skipping CloudWatch alarm creation.'
      );
    return;
  } else {
    log
      .info()
      .str('function', 'manageMemoryAlarmForInstance')
      .str('autoalarm:target', tags['autoalarm:target'])
      .str('instanceId', instanceId)
      .msg(
        'autoalarm:target set to cloudwatch. Skipping prometheus rules and checking if memory metrics are being reported to CW.'
      );
    if (await getMemoryMetricsFromCloudWatch(instanceId, metricName)) {
      log
        .info()
        .str('function', 'manageMemoryAlarmForInstance')
        .str('instanceId', instanceId)
        .str('metricName', metricName)
        .msg('Memory metrics found. Creating CloudWatch alarm');
      if (useAnomalyDetection) {
        await createOrUpdateAnomalyDetectionAlarm(
          anomalyAlarmName,
          'InstanceId',
          instanceId,
          metricName,
          'CWAgent',
          extendedStatistic,
          durationAnomalyTime,
          durationAnomalyPeriods,
          'CRITICAL' as AlarmClassification
        );
      }

      if (
        type === 'WARNING' &&
        (tags['autoalarm:ec2-memory'].split('/')[0] === 'disabled' ||
          tags['autoalarm:ec2-memory'].split('/')[0] === '-')
      ) {
        log
          .info()
          .str('function', 'manageMemoryAlarmForInstance')
          .str('instanceId', instanceId)
          .str('autoalarm:cw-ec2-memory', tags['autoalarm:cw-ec2-memory'])
          .msg(
            'Memory alarm threshold for warning is not defined. Skipping static memory warning alarm creation.'
          );
        await deleteCWAlarm(staticThresholdAlarmName, instanceId);
        return;
      } else if (
        type === 'CRITICAL' &&
        (tags['autoalarm:ec2-memory'].split('/')[1] === 'disabled' ||
          tags['autoalarm:ec2-memory'].split('/')[1] === '-')
      ) {
        log
          .info()
          .str('function', 'manageMemoryAlarmForInstance')
          .str('instanceId', instanceId)
          .str('autoalarm:cw-ec2-memory', tags['autoalarm:cw-ec2-memory'])
          .msg(
            'Memory alarm threshold for critical is not defined. Skipping static memory critical alarm creation.'
          );
        await deleteCWAlarm(staticThresholdAlarmName, instanceId);
        return;
      } else {
        if (extendedStatRegex.test(extendedStatistic)) {
          await createCloudWatchAlarms(
            instanceId,
            staticThresholdAlarmName,
            metricName,
            'CWAgent',
            [{Name: 'InstanceId', Value: instanceId}],
            threshold,
            durationStaticTime,
            durationStaticPeriods,
            type,
            'ignore' as MissingDataTreatment,
            undefined,
            staticStatistic
          );
        } else {
          await createCloudWatchAlarms(
            instanceId,
            staticThresholdAlarmName,
            metricName,
            'CWAgent',
            [{Name: 'InstanceId', Value: instanceId}],
            threshold,
            durationStaticTime,
            durationStaticPeriods,
            type,
            'ignore' as MissingDataTreatment,
            staticStatistic as Statistic,
            undefined
          );
        }
      }
    } else {
      log
        .info()
        .str('function', 'manageMemoryAlarmForInstance')
        .str('instanceId', instanceId)
        .str('metricName', metricName)
        .msg('Memory metrics not found. Skipping alarm creation.');
    }
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
        Period: 60,
        Statistic: 'Average',
        Threshold: 0,
        ActionsEnabled: false,
        Dimensions: [{Name: 'InstanceId', Value: instanceId}],
        Tags: [{Key: 'severity', Value: 'critical'}],
        TreatMissingData: 'breaching',
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
  if (tags['autoalarm:enabled'] === 'false') {
    await deleteCWAlarm(instanceId, 'StatusCheckFailed');
    log.info().msg('Status check alarm creation skipped due to tag settings.');
  } else if (tags['autoalarm:enabled'] === 'true') {
    // Create status check alarm if not disabled
    await createStatusAlarmForInstance(instanceId, doesAlarmExist);
  } else if (tags['autoalarm:enabled'] in tags) {
    log
      .warn()
      .str('function', 'checkAndManageStatusAlarm')
      .msg(
        'autoalarm:enabled tag exists but has unexpected value. checking for alarm and creating if it does not exist'
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
  // Reset flags so prior lambda runs don't carry over old values
  shouldDeletePromAlarm = false;
  shouldUpdatePromRules = false;
  isCloudWatch = true;
  log
    .info()
    .str('function', 'manageActiveInstanceAlarms')
    .str('instanceId', instanceId)
    .str('autoalarm:target', tags['autoalarm:target'])
    .msg('Checking Prometheus tag value before conditional check.');

  if (
    tags['autoalarm:target'] === 'prometheus' ||
    (!tags['autoalarm:target'] && prometheusWorkspaceId !== '') ||
    (tags['autoalarm:target'] !== 'prometheus' &&
      tags['autoalarm:target'] !== 'cloudwatch' &&
      prometheusWorkspaceId !== '')
  ) {
    log
      .info()
      .str('function', 'manageActiveInstanceAlarms')
      .str('instanceId', instanceId)
      .str('Prometheus', tags['autoalarm:target'])
      .msg(
        'Instance is tagged for Prometheus or does not have a autoalarm:target tag but found prometheus workspaceId. ' +
          'Setting isCloudWatch to false.'
      );
    isCloudWatch = false;
  }

  await checkAndManageStatusAlarm(instanceId, tags);

  if (isCloudWatch !== true) {
    log
      .info()
      .str('function', 'manageActiveInstanceAlarms')
      .str('instanceId', instanceId)
      .bool('isCloudWatch', isCloudWatch)
      .str('autoalarm:target', tags['autoalarm:target'])
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
      .str('autoalarm:target', tags['autoalarm:target'])
      .msg(
        'Instance that triggered eventbridge rule is not configured for Prometheus. Setting shouldDeletePromAlarm flag to true.'
      );
    shouldDeletePromAlarm = true;
    isCloudWatch = true;
    await callAlarmFunctions(instanceId, tags, shouldUpdatePromRules);
  }

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
        .str('autoalarm:target', tags['autoalarm:target'])
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
      log
        .error()
        .str('instanceId', instanceId)
        .str('function', 'manageActiveInstanceAlarms')
        .err(e)
        .msg('Error updating Prometheus rules for instances.');
      throw new Error(`Error updating Prometheus rules for instances: ${e}`);
    }
    // If isCloudWatch is true, we will delete the prometheus rules for the instance
  } else {
    log
      .info()
      .str('function', 'manageActiveInstanceAlarms')
      .str('instanceId', instanceId)
      .str('isCloudWatch', isCloudWatch.toString())
      .str('autoalarm:target', tags['autoalarm:target'])
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
    log
      .info()
      .str('function', 'manageActiveInstanceAlarms')
      .str('instanceId', instanceId)
      .str('isCloudWatch', isCloudWatch.toString())
      .msg('Successfully finished managing active instance alarms');
  }
}

export async function manageInactiveInstanceAlarms(instanceId: string) {
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
    log
      .info()
      .str('function', 'manageInactiveInstanceAlarms')
      .str('instanceId', instanceId)
      .str('isCloudWatch', isCloudWatch.toString())
      .msg('Successfully finished managing inactive instance alarms');
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
  //ValidInstanceState.Pending,
]);

export const deadStates: Set<ValidInstanceState> = new Set([
  ValidInstanceState.Terminated,
  //ValidInstanceState.Stopping, //for testing.
  //ValidInstanceState.Stopped, //for testing.
  //ValidInstanceState.ShuttingDown, //for testing.
]);
