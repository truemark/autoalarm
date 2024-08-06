import {OpenSearchClient, ListTagsCommand} from '@aws-sdk/client-opensearch';
import * as logging from '@nr1e/logging';
import {Tag} from './types.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {AlarmClassification} from './enums.mjs';
import {
  getCWAlarmsForInstance,
  deleteCWAlarm,
  doesAlarmExist,
} from './alarm-tools.mjs';
import {
  CloudWatchClient,
  ComparisonOperator,
  DeleteAlarmsCommand,
  PutAnomalyDetectorCommand,
  PutMetricAlarmCommand,
  Statistic,
} from '@aws-sdk/client-cloudwatch';

const log: logging.Logger = logging.getLogger('opensearch-modules');
const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const openSearchClient: OpenSearchClient = new OpenSearchClient({
  region,
  retryStrategy,
});

const cloudWatchClient: CloudWatchClient = new CloudWatchClient({
  region: region,
  retryStrategy: retryStrategy,
});

type MetricConfig = {
  tagKey: string;
  metricName: string;
  namespace: string;
  isDefault: boolean;
  anomaly: boolean;
  defaultValue: string;
};

const metricConfigs = [
  {
    tagKey: 'os-yellow-cluster',
    metricName: 'ClusterStatus.yellow',
    namespace: 'AWS/ES',
    isDefault: true,
    anomaly: false,
    defaultValue: '-/-/300/1/Maximum',
  },
  {
    tagKey: 'os-yellow-cluster-anomaly',
    metricName: 'ClusterStatus.yellow',
    namespace: 'AWS/ES',
    isDefault: true,
    anomaly: true,
    defaultValue: 'Maximum/300/1',
  },
  {
    tagKey: 'os-red-cluster',
    metricName: 'ClusterStatus.red',
    namespace: 'AWS/ES',
    isDefault: true,
    anomaly: false,
    defaultValue: '0-/-/300/1/Maximum',
  },
  {
    tagKey: 'os-red-cluster-anomaly',
    metricName: 'ClusterStatus.red',
    namespace: 'AWS/ES',
    isDefault: true,
    anomaly: true,
    defaultValue: 'Maximum/300/1',
  },
  {
    tagKey: 'os-storage',
    metricName: 'FreeStorageSpace',
    namespace: 'AWS/ES',
    isDefault: true,
    anomaly: false,
    defaultValue: '-/-/300/1/Maximum',
  },
  {
    tagKey: 'os-storage-anomaly',
    metricName: 'FreeStorageSpace',
    namespace: 'AWS/ES',
    isDefault: true,
    anomaly: true,
    defaultValue: 'Maximum/300/1',
  },
  {
    tagKey: 'os-jvm-memory',
    metricName: 'JVMMemoryPressure',
    namespace: 'AWS/ES',
    isDefault: true,
    anomaly: false,
    defaultValue: '-/-/300/1/Maximum',
  },
  {
    tagKey: 'os-jvm-memory-anomaly',
    metricName: 'JVMMemoryPressure',
    namespace: 'AWS/ES',
    isDefault: true,
    anomaly: true,
    defaultValue: 'Maximum/300/1',
  },
  {
    tagKey: 'os-cpu',
    metricName: 'CPUUtilization',
    namespace: 'AWS/ES',
    isDefault: true,
    anomaly: false,
    defaultValue: '-/-/300/1/Maximum',
  },
  {
    tagKey: 'os-cpu-anomaly',
    metricName: 'CPUUtilization',
    namespace: 'AWS/ES',
    isDefault: true,
    anomaly: true,
    defaultValue: 'Maximum/300/1',
  },
];

type TagDefaults = {
  warning: number | undefined;
  critical: number | undefined;
  stat: string;
  duration: number;
  periods: number;
};

function getTagDefaults(config: MetricConfig, tagValue: string): TagDefaults {
  const parts = tagValue ? tagValue.split('/') : [];
  const defaultParts = config.defaultValue.split('/');
  const defaults = defaultParts.map((defaultValue, index) => {
    if (parts.length > index) {
      if (parts[index] !== '') {
        return parts[index];
      }
    }
    return defaultValue;
  });
  if (config.anomaly) {
    // Take the default value which we know is good
    let duration = Number.parseInt(defaultParts[1]);
    try {
      // Override the default if it's a valid number
      duration = Number.parseInt(defaults[1]);
    } catch (err) {
      // do nothing
    }
    // Take the default value which we know is good
    let periods = Number.parseInt(defaultParts[2]);
    try {
      // Override the default is it's a valid number
      periods = Number.parseInt(defaults[2]);
    } catch (err) {
      // do nothing
    }
    return {
      warning: undefined,
      critical: undefined,
      stat: defaults[0],
      duration,
      periods,
    };
  } else {
    let warning = undefined;
    try {
      // If we can't parse the number, we won't create the alarm and it remains undefined
      warning = Number.parseInt(defaults[0]);
    } catch (err) {
      // do nothing
    }
    let critical = undefined;
    try {
      // If we can't parse the number, we won't create the alarm and it remains undefined
      critical = Number.parseInt(defaults[1]);
    } catch (err) {
      // do nothing
    }
    let duration = Number.parseInt(defaultParts[2]);
    try {
      // If we can't parse the number, we won't create the alarm and it remains undefined
      duration = Number.parseInt(defaults[2]);
    } catch (err) {
      // do nothing
    }
    let periods = Number.parseInt(defaultParts[3]);
    try {
      // If we can't parse the number, we won't create the alarm and it remains undefined
      periods = Number.parseInt(defaults[3]);
    } catch (err) {
      // do nothing
    }
    return {
      warning,
      critical,
      duration,
      periods,
      stat: defaults[4],
    };
  }
}

const extendedStatRegex = /^p.*|^tm.*|^tc.*|^ts.*|^wm.*|^IQM$/;

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
  accountID: string,
  tags: Tag,
) {
  const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';

  log.info().msg(accountID);
  if (!isAlarmEnabled) {
    const activeAutoAlarms = await getCWAlarmsForInstance('OS', domainName);
    await Promise.all(
      activeAutoAlarms.map((alarmName) => deleteCWAlarm(alarmName, domainName)),
    );
    log.info().msg('Status check alarm creation skipped due to tag settings.');
    return;
  }

  if (!isAlarmEnabled) {
    const activeAutoAlarms = await getCWAlarmsForInstance('OS', domainName);
    await Promise.all(
      activeAutoAlarms.map((alarmName) => deleteCWAlarm(alarmName, domainName)),
    );
    log.info().msg('Status check alarm creation skipped due to tag settings.');
  }

  // Check and manage alarms for each metric configuration
  for (const config of metricConfigs) {
    log
      .info()
      .str('function', 'checkAndManageOpenSearchStatusAlarms')
      .obj('config', config)
      .str('domainName', domainName)
      .msg('Tag values before processing');

    const tagValue = tags[`autoalarm:${config.tagKey}`];

    if (!config.isDefault && tagValue === undefined) {
      log
        .info()
        .obj('config', config)
        .msg('Not default and tag value is undefined, skipping');
      continue; // not a default and not overridden
    }

    const defaults = getTagDefaults(config, tagValue);
    if (config.anomaly) {
      const alarmName = `AutoAlarm-OS-${domainName}-${config.metricName}-Anomaly-Critical`;
      if (defaults.stat) {
        // Create critical alarm
        if (defaults.stat !== '-' && defaults.stat !== 'disabled') {
          try {
            // Create anomaly detector with the latest parameters
            const anomalyDetectorInput = {
              Namespace: config.namespace,
              MetricName: config.metricName,
              Dimensions: [
                {
                  Name: 'DomainName',
                  Value: domainName,
                },
                {
                  Name: 'ClientId',
                  Value: accountID,
                },
              ],
              Stat: defaults.stat,
              Configuration: {
                MetricTimezone: 'UTC',
              },
            };
            log
              .debug()
              .obj('input', anomalyDetectorInput)
              .msg('Sending PutAnomalyDetectorCommand');
            await cloudWatchClient.send(
              new PutAnomalyDetectorCommand(anomalyDetectorInput),
            );

            // Create anomaly detection alarm
            const metricAlarmInput = {
              AlarmName: alarmName,
              ComparisonOperator: ComparisonOperator.GreaterThanUpperThreshold,
              EvaluationPeriods: defaults.periods,
              Metrics: [
                {
                  Id: 'primaryMetric',
                  MetricStat: {
                    Metric: {
                      Namespace: config.namespace,
                      MetricName: config.metricName,
                      Dimensions: [
                        {
                          Name: 'DomainName',
                          Value: domainName,
                        },
                        {
                          Name: 'ClientId',
                          Value: accountID,
                        },
                      ],
                    },
                    Period: defaults.duration,
                    Stat: defaults.stat,
                  },
                },
                {
                  Id: 'anomalyDetectorBand',
                  Expression: 'ANOMALY_DETECTION_BAND(primaryMetric)',
                },
              ],
              ThresholdMetricId: 'anomalyDetectorBand',
              ActionsEnabled: false,
              Tags: [{Key: ' severity', Value: AlarmClassification.Critical}],
              TreatMissingData: 'ignore', // Adjust as needed
            };
            await cloudWatchClient.send(
              new PutMetricAlarmCommand(metricAlarmInput),
            );

            log
              .info()
              .str('function', 'createOrUpdateAnomalyDetectionAlarm')
              .str('alarmName', alarmName)
              .obj('anomalyDetectorInput', anomalyDetectorInput)
              .obj('metricAlarmInput', metricAlarmInput)
              .msg(`${alarmName} Anomaly Detection Alarm created or updated.`);
          } catch (e) {
            log
              .error()
              .str('function', 'createOrUpdateAnomalyDetectionAlarm')
              .err(e)
              .str('alarmName', alarmName)
              .msg(
                `Failed to create or update ${alarmName} anomaly detection alarm due to an error ${e}`,
              );
          }
        }
      } else if (await doesAlarmExist(alarmName)) {
        await cloudWatchClient.send(
          new DeleteAlarmsCommand({AlarmNames: [alarmName]}),
        );
      }
    } else {
      const alarmNamePrefix = `AutoAlarm-OS-${domainName}-${config.metricName}`;
      // Create warning alarm
      if (defaults.warning) {
        await cloudWatchClient.send(
          new PutMetricAlarmCommand({
            AlarmName: `${alarmNamePrefix}-Warning`,
            ComparisonOperator: 'GreaterThanThreshold',
            EvaluationPeriods: defaults.periods,
            MetricName: config.metricName,
            Namespace: config.namespace,
            Period: defaults.duration,
            ...(extendedStatRegex.test(defaults.stat)
              ? {ExtendedStatistic: defaults.stat}
              : {Statistic: defaults.stat as Statistic}),
            Threshold: defaults.warning,
            ActionsEnabled: false,
            Dimensions: [
              {Name: 'DomainName', Value: domainName},
              {Name: 'ClientId', Value: accountID},
            ],
            Tags: [{Key: 'severity', Value: 'Warning'}],
            TreatMissingData: 'ignore',
          }),
        );
      } else if (await doesAlarmExist(`${alarmNamePrefix}-Warning`)) {
        await cloudWatchClient.send(
          new DeleteAlarmsCommand({AlarmNames: [`${alarmNamePrefix}-Warning`]}),
        );
      }

      // Create critical alarm
      if (defaults.critical) {
        await cloudWatchClient.send(
          new PutMetricAlarmCommand({
            AlarmName: `${alarmNamePrefix}-Critical`,
            ComparisonOperator: 'GreaterThanThreshold',
            EvaluationPeriods: defaults.periods,
            MetricName: config.metricName,
            Namespace: config.namespace,
            Period: defaults.duration,
            ...(extendedStatRegex.test(defaults.stat)
              ? {ExtendedStatistic: defaults.stat}
              : {Statistic: defaults.stat as Statistic}),
            Threshold: defaults.critical,
            ActionsEnabled: false,
            Dimensions: [
              {Name: 'DomainName', Value: domainName},
              {Name: 'ClientId', Value: accountID},
            ],
            Tags: [{Key: 'severity', Value: 'Critical'}],
            TreatMissingData: 'ignore',
          }),
        );
      } else if (await doesAlarmExist(`${alarmNamePrefix}-Critical`)) {
        await cloudWatchClient.send(
          new DeleteAlarmsCommand({
            AlarmNames: [`${alarmNamePrefix}-Critical`],
          }),
        );
      }
    }
  }
}

export async function manageOpenSearchAlarms(
  domainName: string,
  accountID: string,
  tags: Tag,
): Promise<void> {
  await checkAndManageOpenSearchStatusAlarms(domainName, accountID, tags);
}

export async function manageInactiveOpenSearchAlarms(domainName: string) {
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'OS',
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

function extractOSDomainNameFromArn(arn: string): string {
  const regex = /domain\/([^/]+)$/;
  const match = arn.match(regex);
  return match ? match[1] : '';
}

function extractAccountIdFromArn(arn: string): string {
  const parts = arn.split(':');
  return parts.length > 4 ? parts[4] : '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseOSEventAndCreateAlarms(event: any): Promise<{
  domainArn: string;
  accountID: string;
  eventType: string;
  tags: Record<string, string>;
}> {
  let domainArn: string = '';
  let eventType: string = '';
  let tags: Record<string, string> = {};

  switch (event['detail-type']) {
    case 'Tag Change on Resource':
      domainArn = event.resources[0];
      eventType = 'Domain TagChange';
      tags = event.detail.tags || {};
      log
        .info()
        .str('function', 'parseOSEventAndCreateAlarms')
        .str('eventType', eventType)
        .str('domainArn', domainArn)
        .str('changedTags', JSON.stringify(event.detail['changed-tag-keys']))
        .msg('Processing Tag Change event');
      break;

    case 'AWS API Call via CloudTrail':
      switch (event.detail.eventName) {
        case 'CreateDomain':
          domainArn = event.detail.responseElements?.domain?.arn;
          eventType = 'Create';
          log
            .info()
            .str('function', 'parseOSEventAndCreateAlarms')
            .str('eventType', 'Create')
            .str('domainArn', domainArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing CreateDomain event');
          if (domainArn) {
            tags = await fetchOpenSearchTags(domainArn);
            log
              .info()
              .str('function', 'parseOSEventAndCreateAlarms')
              .str('domainArn', domainArn)
              .str('tags', JSON.stringify(tags))
              .msg('Fetched tags for new domain');
          } else {
            log
              .warn()
              .str('function', 'parseOSEventAndCreateAlarms')
              .str('eventType', 'Create')
              .msg('DomainArn not found in CreateDomain event');
          }
          break;

        case 'DeleteDomain':
          domainArn = event.detail.requestParameters?.domainArn;
          eventType = 'Delete';
          log
            .info()
            .str('function', 'parseOSEventAndCreateAlarms')
            .str('eventType', 'Delete')
            .str('domainArn', domainArn)
            .str('requestId', event.detail.requestID)
            .msg('Processing DeleteDomain event');
          break;

        default:
          log
            .warn()
            .str('function', 'parseOSEventAndCreateAlarms')
            .str('eventName', event.detail.eventName)
            .str('requestId', event.detail.requestID)
            .msg('Unexpected CloudTrail event type');
      }
      break;

    default:
      log
        .warn()
        .str('function', 'parseOSEventAndCreateAlarms')
        .str('detail-type', event['detail-type'])
        .msg('Unexpected event type');
  }

  const domainName = extractOSDomainNameFromArn(domainArn);
  const accountID = extractAccountIdFromArn(domainArn);
  if (!domainName) {
    log
      .error()
      .str('function', 'parseOSEventAndCreateAlarms')
      .str('domainArn', domainArn)
      .msg('Extracted domain name is empty');
  }

  log
    .info()
    .str('function', 'parseOSEventAndCreateAlarms')
    .str('domainArn', domainArn)
    .str('eventType', eventType)
    .msg('Finished processing domain event');

  if (
    domainArn &&
    (eventType === 'Create' || eventType === 'Domain TagChange')
  ) {
    log
      .info()
      .str('function', 'parseOSEventAndCreateAlarms')
      .str('domainArn', domainArn)
      .msg('Starting to manage domain alarms');
    await manageOpenSearchAlarms(domainName, accountID, tags);
  } else if (eventType === 'Delete') {
    log
      .info()
      .str('function', 'parseOSEventAndCreateAlarms')
      .str('domainArn', domainArn)
      .msg('Starting to manage inactive domain alarms');
    await manageInactiveOpenSearchAlarms(domainName);
  }

  return {domainArn, accountID, eventType, tags};
}
