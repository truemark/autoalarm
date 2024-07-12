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

const defaultThresholds: {[key in AlarmClassification]: number} = {
  [AlarmClassification.Critical]: 90,
  [AlarmClassification.Warning]: 80,
};

const metricConfigs = [
  {metricName: 'ClusterStatus.yellow', namespace: 'AWS/OpenSearchService'},
  {metricName: 'ClusterStatus.red', namespace: 'AWS/OpenSearchService'},
  {metricName: 'FreeStorageSpace', namespace: 'AWS/OpenSearchService'},
  {metricName: 'JVMMemoryPressure', namespace: 'AWS/OpenSearchService'},
  {metricName: 'CPUUtilization', namespace: 'AWS/OpenSearchService'},
];

async function getAlarmConfig(
  domainName: string,
  type: AlarmClassification,
  metricName: string
): Promise<{
  alarmName: string;
  thresholdKey: string;
  durationTimeKey: string;
  durationPeriodsKey: string;
}> {
  const thresholdKey = `autoalarm:${metricName}-percent-above-${type.toLowerCase()}`;
  const durationTimeKey = `autoalarm:${metricName}-percent-duration-time`;
  const durationPeriodsKey = `autoalarm:${metricName}-percent-duration-periods`;

  return {
    alarmName: `AutoAlarm-OpenSearch-${domainName}-${type}-${metricName}`,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey,
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
        const {alarmName, thresholdKey, durationTimeKey, durationPeriodsKey} =
          await getAlarmConfig(
            domainName,
            classification as AlarmClassification,
            metricName
          );

        const alarmProps: AlarmProps = {
          threshold: defaultThresholds[classification as AlarmClassification],
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
          tags,
          // @ts-ignore
          thresholdKey,
          durationTimeKey,
          // @ts-ignore
          durationPeriodsKey
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
