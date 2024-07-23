import {OpenSearchClient, ListTagsCommand} from '@aws-sdk/client-opensearch';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types.mjs';
import {AlarmClassification, ValidOpenSearchState} from './enums.mjs';
import {
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
} from './alarm-tools.mjs';

const log: logging.Logger = logging.getLogger('opensearch-modules');
const openSearchClient: OpenSearchClient = new OpenSearchClient({});
const metricConfigs = [
  {metricName: 'ClusterStatus.yellow', namespace: 'AWS/OpenSearchService'},
  {metricName: 'ClusterStatus.red', namespace: 'AWS/OpenSearchService'},
  {metricName: 'FreeStorageSpace', namespace: 'AWS/OpenSearchService'},
  {metricName: 'JVMMemoryPressure', namespace: 'AWS/OpenSearchService'},
  {metricName: 'CPUUtilization', namespace: 'AWS/OpenSearchService'},
];

const defaultThreshold = (type: AlarmClassification) =>
  type === 'CRITICAL' ? 95 : 90;

// Default values for duration and periods
const defaultDurationTime = 60; // e.g., 300 seconds
const defaultDurationPeriods = 2; // e.g., 5 periods

async function getAlarmConfig(
  domainName: string,
  type: AlarmClassification,
  metricName: string
): Promise<{
  alarmName: string;
  threshold: number;
  durationTime: number;
  durationPeriods: number;
}> {
  const tags = await fetchOpenSearchTags(domainName);
  const thresholdKey = `autoalarm:${metricName}-percent-above-${type.toLowerCase()}`;
  const durationTimeKey = `autoalarm:${metricName}-percent-duration-time`;
  const durationPeriodsKey = `autoalarm:${metricName}-percent-duration-periods`;

  // Get threshold, duration time, and duration periods from tags or use default values
  const threshold =
    tags[thresholdKey] !== undefined
      ? parseInt(tags[thresholdKey], 10)
      : defaultThreshold(type);
  const durationTime =
    tags[durationTimeKey] !== undefined
      ? parseInt(tags[durationTimeKey], 10)
      : defaultDurationTime;
  const durationPeriods =
    tags[durationPeriodsKey] !== undefined
      ? parseInt(tags[durationPeriodsKey], 10)
      : defaultDurationPeriods;

  return {
    alarmName: `AutoAlarm-OpenSearch-${domainName}-${type}-${metricName}`,
    threshold,
    durationTime,
    durationPeriods,
  };
}

export async function fetchOpenSearchTags(domainArn: string): Promise<Tag> {
  try {
    const command = new ListTagsCommand({
      ARN: domainArn,
    });
    const response = await openSearchClient.send(command);
    const tags: Tag = {};

    response.TagList?.forEach(tag => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .info()
      .str('domainArn', domainArn)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched OpenSearch tags');

    return tags;
  } catch (error) {
    log
      .error()
      .err(error)
      .str('domainArn', domainArn)
      .msg('Error fetching OpenSearch tags');
    return {};
  }
}

async function checkAndManageOpenSearchStatusAlarms(
  domainName: string,
  tags: Tag
) {
  if (tags['autoalarm:disabled'] === 'true') {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'OpenSearch',
      domainName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName => deleteCWAlarm(alarmName, domainName))
    );
    log.info().msg('Status check alarm creation skipped due to tag settings.');
  } else {
    for (const config of metricConfigs) {
      const {metricName, namespace} = config;
      for (const classification of Object.values(AlarmClassification)) {
        const {alarmName, threshold, durationTime, durationPeriods} =
          await getAlarmConfig(
            domainName,
            classification as AlarmClassification,
            metricName
          );

        const alarmProps: AlarmProps = {
          threshold: threshold,
          period: 60,
          namespace: namespace,
          evaluationPeriods: 5,
          metricName: metricName,
          dimensions: [{Name: 'DomainName', Value: domainName}],
        };

        await createOrUpdateCWAlarm(
          alarmName,
          domainName,
          alarmProps,
          threshold,
          durationTime,
          durationPeriods,
          classification
        );
      }
    }
  }
}

export async function manageOpenSearchAlarms(
  domainName: string,
  tags: Tag
): Promise<void> {
  await checkAndManageOpenSearchStatusAlarms(domainName, tags);
}

export async function manageInactiveOpenSearchAlarms(domainName: string) {
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'OpenSearch',
      domainName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName => deleteCWAlarm(alarmName, domainName))
    );
  } catch (e) {
    log.error().err(e).msg(`Error deleting OpenSearch alarms: ${e}`);
    throw new Error(`Error deleting OpenSearch alarms: ${e}`);
  }
}

export async function getOpenSearchState(
  event: any
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
