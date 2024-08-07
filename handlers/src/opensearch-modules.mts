import {OpenSearchClient, ListTagsCommand} from '@aws-sdk/client-opensearch';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {AlarmClassification, ValidOpenSearchState} from './enums.mjs';
import {
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
  createOrUpdateAnomalyDetectionAlarm,
} from './alarm-tools.mjs';

const log: logging.Logger = logging.getLogger('opensearch-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const openSearchClient: OpenSearchClient = new OpenSearchClient({
  region,
  retryStrategy,
});
const metricConfigs = [
  {metricName: 'ClusterStatus.yellow', namespace: 'AWS/OpenSearchService'},
  {metricName: 'ClusterStatus.red', namespace: 'AWS/OpenSearchService'},
  {metricName: 'FreeStorageSpace', namespace: 'AWS/OpenSearchService'},
  {metricName: 'JVMMemoryPressure', namespace: 'AWS/OpenSearchService'},
  {metricName: 'CPUUtilization', namespace: 'AWS/OpenSearchService'},
];

const getDefaultThreshold = (metricName: string, type: AlarmClassification) => {
  if (
    metricName === 'ClusterStatus.yellow' ||
    metricName === 'ClusterStatus.red'
  ) {
    return type === 'Critical' ? 1 : 0;
  } else if (metricName === 'FreeStorageSpace') {
    return type === 'Critical' ? 10 : 5;
  } else if (metricName === 'JVMMemoryPressure') {
    return type === 'Critical' ? 95 : 90;
  } else if (metricName === 'CPUUtilization') {
    return type === 'Critical' ? 95 : 90;
  }
  return 0;
};

// Default values for duration and periods
const defaultStaticDurationTime = 60; // e.g., 300 seconds
const defaultStaticDurationPeriods = 2; // e.g., 5 periods
const defaultAnomalyDurationTime = 60; // e.g., 300 seconds
const defaultAnomalyDurationPeriods = 2; // e.g., 5 periods
const defaultExtendedStatistic: string = 'p90';

async function getOSAlarmConfig(
  domainName: string,
  type: AlarmClassification,
  service: string,
  metricName: string,
  tags: Tag,
): Promise<{
  alarmName: string;
  staticThresholdAlarmName: string;
  anomalyAlarmName: string;
  extendedStatistic: string;
  threshold: number;
  durationStaticTime: number;
  durationStaticPeriods: number;
  durationAnomalyTime: number;
  durationAnomalyPeriods: number;
}> {
  log
    .info()
    .str('function', 'getOSAlarmConfig')
    .str('domainName', domainName)
    .str('type', type)
    .str('metricName', metricName)
    .msg('Fetching alarm config');

  // Initialize variables with default values
  let threshold = getDefaultThreshold(metricName, type);
  let extendedStatistic = defaultExtendedStatistic;
  let durationStaticTime = defaultStaticDurationTime;
  let durationStaticPeriods = defaultStaticDurationPeriods;
  let durationAnomalyTime = defaultAnomalyDurationTime;
  let durationAnomalyPeriods = defaultAnomalyDurationPeriods;

  log
    .info()
    .str('function', 'getOSAlarmConfig')
    .str('domainName', domainName)
    .msg('Fetching alarm configuration');

  let cwTagKey = '';
  let anomalyTagKey = '';

  switch (metricName) {
    case 'ClusterStatus.yellow':
      cwTagKey = 'autoalarm:cw-opensearch-yellow-cluster-status';
      anomalyTagKey = 'autoalarm:anomaly-opensearch-yellow-status';
      break;
    case 'ClusterStatus.red':
      cwTagKey = 'autoalarm:cw-opensearch-red-cluster-status';
      anomalyTagKey = 'autoalarm:anomaly-opensearch-red-status';
      break;
    case 'FreeStorageSpace':
      cwTagKey = 'autoalarm:cw-opensearch-storage';
      anomalyTagKey = 'autoalarm:anomaly-opensearch-storage';
      break;
    case 'JVMMemoryPressure':
      cwTagKey = 'autoalarm:cw-opensearch-jvm-memory';
      anomalyTagKey = 'autoalarm:anomaly-opensearch-jvm-memory';
      break;
    case 'CPUUtilization':
      cwTagKey = 'autoalarm:cw-opensearch-cpu';
      anomalyTagKey = 'autoalarm:anomaly-opensearch-cpu';
      break;
    default:
      log
        .info()
        .str('function', 'getOSAlarmConfig')
        .str('domainName', domainName)
        .str('metricName', metricName)
        .msg('Invalid metric name');
      break;
  }
  log
    .info()
    .str('function', 'getOSAlarmConfig')
    .str('domainName', domainName)
    .str('tags', JSON.stringify(tags))
    .str('cwTagKey', cwTagKey)
    .str('cwTagKey', cwTagKey)
    .str('cwTagValue', tags[cwTagKey])
    .str('anomalyTagKey', anomalyTagKey)
    .str('anomalyTagValue', tags[anomalyTagKey])
    .msg('Fetched instance tags');

  // Extract and parse the tag value
  if (tags[cwTagKey]) {
    const staticValues = tags[cwTagKey].split('/');
    log
      .info()
      .str('function', 'getOSAlarmConfig')
      .str('domainName', domainName)
      .str('tagKey', cwTagKey)
      .str('tagValue', tags[cwTagKey])
      .str('staticValues', JSON.stringify(staticValues))
      .msg('Fetched static threshold tag values');

    if (staticValues.length < 1 || staticValues.length > 4) {
      log
        .warn()
        .str('function', 'getOSAlarmConfig')
        .str('domainName', domainName)
        .str('tagKey', cwTagKey)
        .str('tagValue', tags[cwTagKey])
        .msg(
          'Invalid tag values/delimiters. Please use 4 values separated by a "/". Using default values',
        );
    } else {
      switch (type) {
        case 'Warning':
          threshold =
            staticValues[0] !== undefined &&
            staticValues[0] !== '' &&
            !isNaN(parseInt(staticValues[0], 10))
              ? parseInt(staticValues[0], 10)
              : getDefaultThreshold(metricName, type);
          durationStaticTime =
            staticValues[2] !== undefined &&
            staticValues[2] !== '' &&
            !isNaN(parseInt(staticValues[2], 10))
              ? parseInt(staticValues[2], 10)
              : defaultStaticDurationTime;
          durationStaticPeriods =
            staticValues[3] !== undefined &&
            staticValues[3] !== '' &&
            !isNaN(parseInt(staticValues[3], 10))
              ? parseInt(staticValues[3], 10)
              : defaultStaticDurationPeriods;
          break;
        case 'Critical':
          threshold =
            staticValues[1] !== undefined &&
            staticValues[1] !== '' &&
            !isNaN(parseInt(staticValues[1], 10))
              ? parseInt(staticValues[1], 10)
              : getDefaultThreshold(metricName, type);
          durationStaticTime =
            staticValues[2] !== undefined &&
            staticValues[2] !== '' &&
            !isNaN(parseInt(staticValues[2], 10))
              ? parseInt(staticValues[2], 10)
              : defaultStaticDurationTime;
          durationStaticPeriods =
            staticValues[3] !== undefined &&
            staticValues[3] !== '' &&
            !isNaN(parseInt(staticValues[3], 10))
              ? parseInt(staticValues[3], 10)
              : defaultStaticDurationPeriods;
          break;
      }
    }
  }
  // Extract and parse the anomaly detection tag value
  if (tags[anomalyTagKey]) {
    const values = tags[anomalyTagKey].split('|');
    log
      .info()
      .str('function', 'getOSAlarmConfig')
      .str('domainName', domainName)
      .str('tagKey', anomalyTagKey)
      .str('tagValue', tags[anomalyTagKey])
      .str('values', JSON.stringify(values))
      .msg('Fetched anomaly detection tag values');
    if (values.length < 1 || values.length > 3) {
      log
        .warn()
        .str('function', 'getOSAlarmConfig')
        .str('domainName', domainName)
        .str('tagKey', anomalyTagKey)
        .str('tagValue', tags[anomalyTagKey])
        .msg(
          'Invalid tag values/delimiters. Please use 3 values separated by a "|". Using default values',
        );
    } else {
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
        .str('function', 'getOSAlarmConfig')
        .str('domainName', domainName)
        .str('tagKey', anomalyTagKey)
        .str('tagValue', tags[anomalyTagKey])
        .str('extendedStatistic', extendedStatistic)
        .num('durationAnomalyTime', durationAnomalyTime)
        .num('durationAnomalyPeriods', durationAnomalyPeriods)
        .msg('Parsed anomaly detection tag values');
    }
  }
  log
    .info()
    .str('function', 'getOSAlarmConfig')
    .str('domainName', domainName)
    .str('type', type)
    .str('metric', metricName)
    .str(
      'staticThresholdAlarmName',
      `AutoAlarm-OpenSearch-StaticThreshold-${domainName}-${type}-${metricName.toUpperCase()}`,
    )
    .str(
      'anomalyAlarmName',
      `AutoAlarm-OpenSearch-AnomalyDetection-${domainName}-${type}-${metricName.toUpperCase()}`,
    )
    .str('extendedStatistic', extendedStatistic)
    .num('threshold', threshold)
    .num('durationStaticTime', durationStaticTime)
    .num('durationStaticPeriods', durationStaticPeriods)
    .num('durationAnomalyTime', durationAnomalyTime)
    .num('durationAnomalyPeriods', durationAnomalyPeriods)
    .msg('Fetched alarm configuration');

  return {
    alarmName: `AutoAlarm-${service.toUpperCase()}-${domainName}-${type}-${metricName.toUpperCase()}`,
    staticThresholdAlarmName: `AutoAlarm-${service.toUpperCase()}-StaticThreshold-${domainName}-${type}-${metricName.toUpperCase()}`,
    anomalyAlarmName: `AutoAlarm-${service.toUpperCase()}-AnomalyDetection-${domainName}-${type}-${metricName.toUpperCase()}`,
    extendedStatistic,
    threshold,
    durationStaticTime,
    durationStaticPeriods,
    durationAnomalyTime,
    durationAnomalyPeriods,
  };
}

export async function fetchOpenSearchTags(domainArn: string): Promise<Tag> {
  try {
    const command = new ListTagsCommand({
      ARN: domainArn,
    });
    const response = await openSearchClient.send(command);
    const tags: Tag = {};

    response.TagList?.forEach((tag) => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .info()
      .str('function', 'fetchOpenSearchTags')
      .str('domainArn', domainArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched OpenSearch tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchOpenSearchTags')
      .err(error)
      .str('domainArn', domainArn)
      .msg('Error fetching OpenSearch tags');
    return {};
  }
}

async function checkAndManageOpenSearchStatusAlarms(
  domainName: string,
  tags: Tag,
) {
  if (tags['autoalarm:enabled'] === 'false' || !tags['autoalarm:enabled']) {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'OpenSearch',
      domainName,
    );
    await Promise.all(
      activeAutoAlarms.map((alarmName) => deleteCWAlarm(alarmName, domainName)),
    );
    log.info().msg('Status check alarm creation skipped due to tag settings.');
  } else if (tags['autoalarm:enabled'] === undefined) {
    log
      .info()
      .msg(
        'Status check alarm creation skipped due to missing autoalarm:enabled tag.',
      );
    return;
  } else {
    for (const config of metricConfigs) {
      const {metricName, namespace} = config;
      let cwTagKey = '';
      let anomalyTagKey = '';
      switch (metricName) {
        case 'ClusterStatus.yellow':
          cwTagKey = 'autoalarm:cw-opensearch-yellow-cluster-status';
          anomalyTagKey = 'autoalarm:anomaly-opensearch-yellow-status';
          break;
        case 'ClusterStatus.red':
          cwTagKey = 'autoalarm:cw-opensearch-red-cluster-status';
          anomalyTagKey = 'autoalarm:anomaly-opensearch-red-status';
          break;
        case 'FreeStorageSpace':
          cwTagKey = 'autoalarm:cw-opensearch-storage';
          anomalyTagKey = 'autoalarm:anomaly-opensearch-storage';
          break;
        case 'JVMMemoryPressure':
          cwTagKey = 'autoalarm:cw-opensearch-jvm-memory';
          anomalyTagKey = 'autoalarm:anomaly-opensearch-jvm-memory';
          break;
        case 'CPUUtilization':
          cwTagKey = 'autoalarm:cw-opensearch-cpu';
          anomalyTagKey = 'autoalarm:anomaly-opensearch-cpu';
          break;
        default:
          log
            .info()
            .str('function', 'getOSAlarmConfig')
            .str('domainName', domainName)
            .str('metricName', metricName)
            .msg('Invalid metric name');
          break;
      }

      log
        .info()
        .str('function', 'checkAndManageOpenSearchStatusAlarms')
        .str('domainName', domainName)
        .str('cwTagKey', cwTagKey)
        .str('cwTagValue', tags[cwTagKey] || 'undefined')
        .str('anomalyTagKey', anomalyTagKey)
        .str('anomalyTagValue', tags[anomalyTagKey] || 'undefined')
        .msg('Tag values before processing');
      for (const type of ['Warning', 'Critical'] as AlarmClassification[]) {
        const {
          staticThresholdAlarmName,
          anomalyAlarmName,
          extendedStatistic,
          threshold,
          durationStaticTime,
          durationStaticPeriods,
          durationAnomalyTime,
          durationAnomalyPeriods,
        } = await getOSAlarmConfig(
          domainName,
          type,
          'OpenSearch',
          metricName,
          tags,
        );
        await createOrUpdateAnomalyDetectionAlarm(
          anomalyAlarmName,
          'OpenSearch',
          domainName,
          metricName,
          namespace,
          extendedStatistic,
          durationAnomalyTime,
          durationAnomalyPeriods,
          'Critical' as AlarmClassification,
        );
        // Check and create or delete static threshold alarm based on tag values
        if (
          type === 'Warning' &&
          (!tags[cwTagKey] ||
            tags[cwTagKey].split('/')[0] === undefined ||
            tags[cwTagKey].split('/')[0] === '' ||
            !tags[cwTagKey].split('/')[0])
        ) {
          log
            .info()
            .str('function', 'checkAndManageOpenSearchStatusAlarms')
            .str('domainName', domainName)
            .str(cwTagKey, tags[cwTagKey])
            .msg(
              `OS alarm threshold for ${metricName} Warning is not defined. Skipping static ${metricName} Warning alarm creation.`,
            );
          await deleteCWAlarm(staticThresholdAlarmName, domainName);
        } else if (
          type === 'Critical' &&
          (!tags[cwTagKey] ||
            tags[cwTagKey].split('/')[1] === '' ||
            tags[cwTagKey].split('/')[1] === undefined ||
            !tags[cwTagKey].split('/')[1])
        ) {
          log
            .info()
            .str('function', 'checkAndManageOpenSearchStatusAlarms')
            .str('domainName', domainName)
            .str(cwTagKey, tags[cwTagKey])
            .msg(
              `OS alarm threshold for ${metricName} Critical is not defined. Skipping static ${metricName} Critical alarm creation.`,
            );
          await deleteCWAlarm(staticThresholdAlarmName, domainName);
        } else {
          const alarmProps: AlarmProps = {
            threshold: threshold,
            period: 60,
            namespace: namespace,
            evaluationPeriods: 5,
            metricName: metricName,
            dimensions: [{Name: 'DomainName', Value: domainName}],
          };

          await createOrUpdateCWAlarm(
            staticThresholdAlarmName,
            domainName,
            alarmProps,
            threshold,
            durationStaticTime,
            durationStaticPeriods,
            'Maximum',
            'ignore',
            // TODO This need to be fixed. Don't use //@ts-ignore
            // type as AlarmClassification,
          );
        }
      }
    }
  }
}

export async function manageOpenSearchAlarms(
  domainName: string,
  tags: Tag,
): Promise<void> {
  await checkAndManageOpenSearchStatusAlarms(domainName, tags);
}

export async function manageInactiveOpenSearchAlarms(domainName: string) {
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'OpenSearch',
      domainName,
    );
    await Promise.all(
      activeAutoAlarms.map((alarmName) => deleteCWAlarm(alarmName, domainName)),
    );
  } catch (e) {
    log.error().err(e).msg(`Error deleting OpenSearch alarms: ${e}`);
    throw new Error(`Error deleting OpenSearch alarms: ${e}`);
  }
}

export async function getOpenSearchState(
  // TODO Fix the use of any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any,
): Promise<{domainArn: string; state: ValidOpenSearchState; tags: Tag}> {
  const domainArn = event.detail['domain-arn'];
  const state = event.detail.state;
  const tags = await fetchOpenSearchTags(domainArn);

  if (domainArn && state === ValidOpenSearchState.Active) {
    await manageOpenSearchAlarms(domainArn, tags);
  } else if (state === ValidOpenSearchState.Deleted) {
    await manageInactiveOpenSearchAlarms(domainArn);
  }

  return {domainArn, state, tags};
}
