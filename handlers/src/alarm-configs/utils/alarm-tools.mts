import {
  CloudWatchClient,
  ComparisonOperator,
  DeleteAlarmsCommand,
  DeleteAnomalyDetectorCommand,
  DescribeAlarmsCommand,
  DescribeAlarmsCommandOutput,
  MetricAlarm,
  PutAnomalyDetectorCommand,
  PutAnomalyDetectorCommandInput,
  PutMetricAlarmCommand,
  PutMetricAlarmCommandInput,
  Statistic,
  MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';

import {
  MetricAlarmConfig,
  MetricAlarmOptions,
  AlarmClassification,
} from '../../types/index.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import * as logging from '@nr1e/logging';

const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const log = logging.getLogger('alarm-tools');
const cloudWatchClient = new CloudWatchClient({
  region,
  retryStrategy: retryStrategy,
});

export async function doesAlarmExist(alarmName: string): Promise<boolean> {
  //initialize response variable
  let response: DescribeAlarmsCommandOutput;
  try {
    response = await cloudWatchClient.send(
      new DescribeAlarmsCommand({AlarmNames: [alarmName]}),
    );
    log
      .info()
      .str('function', 'doesAlarmExist')
      .str('alarmName', alarmName)
      .str('response', JSON.stringify(response))
      .msg('Checking if alarm exists');
  } catch (error) {
    log
      .error()
      .str('function', 'doesAlarmExist')
      .str('alarmName', alarmName)
      .str('error', String(error))
      .msg('Failed to check if alarm exists');
    throw error;
  }
  return (response.MetricAlarms?.length ?? 0) > 0;
}

// The DeleteAlarms API accepts at most 100 alarm names per call.
const DELETE_ALARMS_MAX_BATCH_SIZE = 100;

/**
 * Splits an array of alarm names into chunks no larger than the DeleteAlarms
 * API limit (100 names per call).
 */
export function chunkAlarmNames(alarmNames: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < alarmNames.length; i += DELETE_ALARMS_MAX_BATCH_SIZE) {
    chunks.push(alarmNames.slice(i, i + DELETE_ALARMS_MAX_BATCH_SIZE));
  }
  return chunks;
}

/**
 * Builds the exact set of alarm names AutoAlarm could have created for a
 * resource, based on the service's alarm configs. Reuses {@link buildAlarmName}
 * so the formats stay identical to alarm creation. Used to ensure deletion
 * only ever targets this resource's own alarms and never alarms belonging to
 * another resource whose identifier shares a prefix (e.g., 'orders' vs
 * 'orders-dlq').
 *
 * Note: EC2 is intentionally not reconciled via this helper. EC2 storage
 * alarms embed dynamic storage paths and platform-resolved metric names, so
 * the EC2 module keeps prefix-based reconciliation (instance ids are
 * fixed-format and cannot prefix-collide).
 */
export function buildExpectedAlarmNames(
  service: string,
  identifier: string,
  configs: MetricAlarmConfig[],
): Set<string> {
  const expectedAlarmNames = new Set<string>();
  for (const config of configs) {
    const alarmVariant = config.tagKey.includes('anomaly')
      ? 'anomaly'
      : 'static';
    for (const classification of Object.values(AlarmClassification)) {
      expectedAlarmNames.add(
        buildAlarmName(
          config,
          service,
          identifier,
          classification,
          alarmVariant,
        ),
      );
    }
  }
  return expectedAlarmNames;
}

export async function deleteExistingAlarms(
  service: string,
  identifier: string,
  configs: MetricAlarmConfig[],
) {
  if (!identifier) {
    log
      .error()
      .str('function', 'deleteExistingAlarms')
      .str('Service', service)
      .msg('Identifier is empty. Refusing to delete alarms by service prefix');
    throw new Error(
      `deleteExistingAlarms called with empty identifier for service ${service}`,
    );
  }

  log
    .info()
    .str('function', 'deleteExistingAlarms')
    .str('Service', service)
    .str('Identifier', identifier)
    .msg('Fetching and deleting existing alarms');
  const expectedAlarmNames = buildExpectedAlarmNames(
    service,
    identifier,
    configs,
  );
  // Only delete alarms whose names exactly match the names AutoAlarm could
  // have created for this resource. This prevents the AlarmNamePrefix fetch
  // from deleting alarms belonging to another resource whose identifier
  // shares a prefix with this one.
  const activeAutoAlarms = (
    await getCWAlarmsForInstance(service, identifier)
  ).filter((alarmName) => expectedAlarmNames.has(alarmName));

  log
    .info()
    .str('function', 'deleteExistingAlarms')
    .obj('AlarmName', activeAutoAlarms)
    .msg('Deleting alarm');
  await massDeleteAlarms(activeAutoAlarms);
}

async function deleteAlarmsForConfig(
  config: MetricAlarmConfig,
  service: string,
  serviceIdentifier: string,
  dimensions: {Name: string; Value: string}[],
  statistic: string | undefined,
) {
  // Only delete the alarm variant this config represents. Deleting both
  // variants here would let a no-threshold anomaly config delete the sibling
  // static alarms managed by a different config (and vice versa).
  const alarmVariant = config.tagKey.includes('anomaly') ? 'anomaly' : 'static';
  for (const classification of Object.values(AlarmClassification)) {
    const alarmName = buildAlarmName(
      config,
      service,
      serviceIdentifier,
      classification,
      alarmVariant,
    );
    await deleteAlarm(alarmName);
  }

  // Anomaly alarms are backed by an anomaly detector model created via
  // PutAnomalyDetector. Delete it as well so orphaned models do not
  // accumulate toward the regional anomaly detector quota.
  if (alarmVariant === 'anomaly') {
    await deleteAnomalyDetector(config, dimensions, statistic);
  }
}

async function deleteAnomalyDetector(
  config: MetricAlarmConfig,
  dimensions: {Name: string; Value: string}[],
  statistic: string | undefined,
) {
  try {
    await cloudWatchClient.send(
      new DeleteAnomalyDetectorCommand({
        Namespace: config.metricNamespace,
        MetricName: config.metricName,
        Dimensions: [...dimensions],
        Stat: statistic,
      }),
    );
    log
      .info()
      .str('function', 'deleteAnomalyDetector')
      .str('Namespace', config.metricNamespace)
      .str('MetricName', config.metricName)
      .msg('Successfully deleted anomaly detector');
  } catch (e) {
    if (e instanceof Error && e.name === 'ResourceNotFoundException') {
      log
        .debug()
        .str('function', 'deleteAnomalyDetector')
        .str('Namespace', config.metricNamespace)
        .str('MetricName', config.metricName)
        .msg('Anomaly detector does not exist. Nothing to delete');
      return;
    }
    log
      .error()
      .str('function', 'deleteAnomalyDetector')
      .str('Namespace', config.metricNamespace)
      .str('MetricName', config.metricName)
      .err(e)
      .msg('Error deleting anomaly detector');
    throw e;
  }
}

export async function deleteAlarm(alarmName: string) {
  log
    .info()
    .str('function', 'deleteAlarm')
    .str('AlarmName', alarmName)
    .msg('Attempting to delete alarm');
  try {
    await cloudWatchClient.send(
      new DeleteAlarmsCommand({AlarmNames: [alarmName]}),
    );
    log
      .info()
      .str('function', 'deleteAlarm')
      .str('AlarmName', alarmName)
      .msg('Successfully deleted alarm');
  } catch (e) {
    log
      .error()
      .str('function', 'deleteAlarm')
      .str('AlarmName', alarmName)
      .err(e)
      .msg('Error deleting alarm');
  }
}

export async function massDeleteAlarms(alarmNames: string[]) {
  if (alarmNames.length === 0) {
    log
      .info()
      .str('function', 'massDeleteAlarms')
      .msg('No alarms to delete. Skipping DeleteAlarms call');
    return;
  }
  log
    .info()
    .str('function', 'massDeleteAlarms')
    .str('AlarmNames', JSON.stringify(alarmNames))
    .msg('Attempting to delete alarms');
  try {
    // DeleteAlarms accepts at most 100 alarm names per call, so delete in chunks.
    for (const alarmNamesChunk of chunkAlarmNames(alarmNames)) {
      await cloudWatchClient.send(
        new DeleteAlarmsCommand({AlarmNames: alarmNamesChunk}),
      );
    }
    log
      .info()
      .str('function', 'massDeleteAlarms')
      .str('AlarmNames', JSON.stringify(alarmNames))
      .msg('Successfully deleted alarms');
  } catch (e) {
    log
      .error()
      .str('function', 'massDeleteAlarms')
      .str('AlarmNames', JSON.stringify(alarmNames))
      .err(e)
      .msg('Error deleting alarms');
    // Rethrow so callers can fail the record instead of silently dropping the
    // deletion and acknowledging the event.
    throw e;
  }
}

export function buildAlarmName(
  config: MetricAlarmConfig,
  service: string,
  serviceIdentifier: string,
  classification: AlarmClassification,
  alarmVariant: 'anomaly' | 'static',
  storagePath?: string,
) {
  if (storagePath) {
    const alarmName =
      alarmVariant === 'anomaly'
        ? `AutoAlarm-${service.toUpperCase()}-${serviceIdentifier}-${config.metricName}-${storagePath}-anomaly-${classification}`
        : `AutoAlarm-${service.toUpperCase()}-${serviceIdentifier}-${config.metricName}-${storagePath}-${classification}`;
    log
      .info()
      .str('function', 'buildAlarmName')
      .str('AlarmName', alarmName)
      .msg('Built alarm name name');
    return alarmName;
  } else {
    const alarmName =
      alarmVariant === 'anomaly'
        ? `AutoAlarm-${service.toUpperCase()}-${serviceIdentifier}-${config.metricName}-anomaly-${classification}`
        : `AutoAlarm-${service.toUpperCase()}-${serviceIdentifier}-${config.metricName}-${classification}`;
    log
      .info()
      .str('function', 'buildAlarmName')
      .str('AlarmName', alarmName)
      .msg('Built alarm name name');
    return alarmName;
  }
}

// used as input validation to ensure that the period value is always a valid number for the cloudwatch api
// Valid CloudWatch periods are 10, 30, and any multiple of 60.
function validatePeriod(period: number) {
  if (period === 10 || period === 30 || (period >= 60 && period % 60 === 0)) {
    log
      .info()
      .str('function', 'validatePeriod')
      .str('period', period.toString())
      .msg('Period is valid');
    return period;
  } else if (period < 10) {
    log
      .info()
      .str('function', 'validatePeriod')
      .str('period', period.toString())
      .msg('Period is less than 10, setting to 10');
    return 10;
  } else if (period < 30) {
    log
      .info()
      .str('function', 'validatePeriod')
      .str('period', period.toString())
      .msg('Period is between 11 and 29, setting to 30');
    return 30;
  } else {
    log
      .info()
      .str('function', 'validatePeriod')
      .str('period', period.toString())
      .msg(
        'Period is greater than 30 and not a multiple of 60, rounding up to the next multiple of 60',
      );
    return Math.ceil(period / 60) * 60;
  }
}

/**
 * Comparison operators that are only valid for anomaly detection alarms.
 * Static threshold alarms must NOT use these, and anomaly alarms must ONLY use these.
 */
const ANOMALY_COMPARISON_OPERATORS: ComparisonOperator[] = [
  ComparisonOperator.GreaterThanUpperThreshold,
  ComparisonOperator.LessThanLowerThreshold,
  ComparisonOperator.LessThanLowerOrGreaterThanUpperThreshold,
];

/**
 * Ensures the comparison operator matches the alarm variant (anomaly vs static).
 * Tag parsing accepts any valid ComparisonOperator, so a mismatched operator
 * (e.g. a static operator on an anomaly alarm) would make PutMetricAlarm reject
 * the request and send the record to the DLQ. If a mismatch is detected, log a
 * warning and fall back to the config's default operator.
 */
function validateComparisonOperator(
  config: MetricAlarmConfig,
  updatedDefaults: MetricAlarmOptions,
  variant: 'anomaly' | 'static',
): void {
  const isAnomalyOperator = ANOMALY_COMPARISON_OPERATORS.includes(
    updatedDefaults.comparisonOperator,
  );

  if (
    (variant === 'anomaly' && !isAnomalyOperator) ||
    (variant === 'static' && isAnomalyOperator)
  ) {
    log
      .warn()
      .str('function', 'validateComparisonOperator')
      .str('tagKey', config.tagKey)
      .str('variant', variant)
      .str('comparisonOperator', updatedDefaults.comparisonOperator)
      .str('defaultComparisonOperator', config.defaults.comparisonOperator)
      .msg(
        'Comparison operator is not valid for this alarm variant. Falling back to the config default operator.',
      );
    updatedDefaults.comparisonOperator = config.defaults.comparisonOperator;
  }
}

async function handleAnomalyDetectionWorkflow(
  alarmName: string,
  updatedDefaults: MetricAlarmOptions,
  config: MetricAlarmConfig,
  dimensions: {Name: string; Value: string}[],
  classification: AlarmClassification,
  threshold: number,
) {
  log
    .info()
    .str('function', 'handleAnomalyDetectionWorkflow')
    .str('AlarmName', alarmName)
    .msg('Handling anomaly detection alarm workflow');

  try {
    const anomalyDetectorInput: PutAnomalyDetectorCommandInput = {
      Namespace: config.metricNamespace,
      MetricName: config.metricName,
      Dimensions: [...dimensions],
      Stat: updatedDefaults.statistic,
      Configuration: {MetricTimezone: 'UTC'},
    };

    const response = await cloudWatchClient.send(
      new PutAnomalyDetectorCommand(anomalyDetectorInput),
    );
    log
      .info()
      .str('function', 'handleAnomalyDetectionWorkflow')
      .str('AlarmName', alarmName)
      .obj('response', response)
      .msg('Successfully created or updated anomaly detector');

    const metrics: MetricDataQuery[] = [
      {
        Id: 'primaryMetric',
        MetricStat: {
          Metric: {
            Namespace: config.metricNamespace,
            MetricName: config.metricName,
            Dimensions: [...dimensions],
          },
          Period: updatedDefaults.period,
          Stat: updatedDefaults.statistic,
        },
      },
      {
        Id: 'anomalyDetectionBand',
        Expression: `ANOMALY_DETECTION_BAND(primaryMetric, ${threshold})`,
      },
    ];

    const alarmInput: PutMetricAlarmCommandInput = {
      AlarmName: alarmName,
      ComparisonOperator: updatedDefaults.comparisonOperator,
      EvaluationPeriods: updatedDefaults.evaluationPeriods,
      DatapointsToAlarm: updatedDefaults.dataPointsToAlarm,
      Metrics: metrics,
      ThresholdMetricId: 'anomalyDetectionBand',
      ActionsEnabled: false,
      Tags: [{Key: 'severity', Value: classification}],
      TreatMissingData: updatedDefaults.missingDataTreatment,
    };

    log
      .info()
      .str('function', 'handleAnomalyDetectionWorkflow')
      .obj('AlarmInput', alarmInput)
      .msg('Sending PutMetricAlarmCommand');

    const alarmResponse = await cloudWatchClient.send(
      new PutMetricAlarmCommand(alarmInput),
    );
    log
      .info()
      .str('function', 'handleAnomalyDetectionWorkflow')
      .str('AlarmName', alarmName)
      .obj('response', alarmResponse)
      .msg('Successfully created or updated anomaly detection alarm');
  } catch (e) {
    log
      .error()
      .str('function', 'handleAnomalyDetectionWorkflow')
      .str('AlarmName', alarmName)
      .err(e)
      .msg('Error creating or updating anomaly detection alarm');
    // Rethrow the error so it can be caught by the caller
    throw e;
  }
}

//TODO: Confirm that we do not need to differentiate between Standard Statistics and Extended Statistics
export async function handleAnomalyAlarms(
  config: MetricAlarmConfig,
  service: string,
  serviceIdentifier: string,
  dimensions: {Name: string; Value: string}[],
  updatedDefaults: MetricAlarmOptions,
  storagePath?: string,
): Promise<string[]> {
  const createdAlarms: string[] = [];

  // Validate if thresholds are set correctly
  const warningThresholdSet =
    updatedDefaults.warningThreshold !== undefined &&
    updatedDefaults.warningThreshold !== null;
  const criticalThresholdSet =
    updatedDefaults.criticalThreshold !== undefined &&
    updatedDefaults.criticalThreshold !== null;

  // If no thresholds are set, log and exit early
  if (!warningThresholdSet && !criticalThresholdSet && !config.defaultCreate) {
    const alarmPrefix = `AutoAlarm-${service}-${serviceIdentifier}-${config.metricName}-anomaly-`;
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('Service Identifier', serviceIdentifier)
      .str('alarm prefix: ', alarmPrefix)
      .msg(
        'No thresholds defined, skipping alarm creation and deleting alarms for config if they exist.',
      );
    await deleteAlarmsForConfig(
      config,
      service,
      serviceIdentifier,
      dimensions,
      updatedDefaults.statistic,
    );
    return createdAlarms;
  }

  updatedDefaults.period = validatePeriod(updatedDefaults.period);
  validateComparisonOperator(config, updatedDefaults, 'anomaly');

  // Handle warning anomaly alarm
  if (warningThresholdSet) {
    const warningAlarmName = buildAlarmName(
      config,
      service,
      serviceIdentifier,
      AlarmClassification.Warning,
      'anomaly',
      storagePath,
    );
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('AlarmName', warningAlarmName)
      .msg('Creating or updating warning anomaly alarm');
    await handleAnomalyDetectionWorkflow(
      warningAlarmName,
      updatedDefaults,
      config,
      dimensions,
      AlarmClassification.Warning,
      updatedDefaults.warningThreshold as number,
    );
    createdAlarms.push(warningAlarmName);
  } else {
    const warningAlarmName = buildAlarmName(
      config,
      service,
      serviceIdentifier,
      AlarmClassification.Warning,
      'anomaly',
      storagePath,
    );
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('AlarmName', warningAlarmName)
      .msg('Deleting existing warning anomaly alarm due to no threshold.');
    await deleteAlarm(warningAlarmName);
  }

  // Handle critical anomaly alarm
  if (criticalThresholdSet) {
    const criticalAlarmName = buildAlarmName(
      config,
      service,
      serviceIdentifier,
      AlarmClassification.Critical,
      'anomaly',
      storagePath,
    );
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('AlarmName', criticalAlarmName)
      .msg('Creating or updating critical anomaly alarm');
    await handleAnomalyDetectionWorkflow(
      criticalAlarmName,
      updatedDefaults,
      config,
      dimensions,
      AlarmClassification.Critical,
      updatedDefaults.criticalThreshold as number,
    );
    createdAlarms.push(criticalAlarmName);
  } else {
    const criticalAlarmName = buildAlarmName(
      config,
      service,
      serviceIdentifier,
      AlarmClassification.Critical,
      'anomaly',
      storagePath,
    );
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('AlarmName', criticalAlarmName)
      .msg('Deleting existing critical anomaly alarm due to no threshold.');
    await deleteAlarm(criticalAlarmName);
  }

  return createdAlarms;
}

async function handleStaticThresholdWorkflow(
  alarmName: string,
  updatedDefaults: MetricAlarmOptions,
  config: MetricAlarmConfig,
  dimensions: {Name: string; Value: string}[],
  classification: AlarmClassification,
  threshold: number,
) {
  log
    .info()
    .str('function', 'handleStaticThresholdWorkflow')
    .str('AlarmName', alarmName)
    .msg('Handling static threshold alarm workflow');

  try {
    const alarmInput: PutMetricAlarmCommandInput = {
      AlarmName: alarmName,
      ComparisonOperator: updatedDefaults.comparisonOperator,
      EvaluationPeriods: updatedDefaults.evaluationPeriods,
      DatapointsToAlarm: updatedDefaults.dataPointsToAlarm,
      MetricName: config.metricName,
      Namespace: config.metricNamespace,
      Period: updatedDefaults.period,
      ...([
        'p',
        'tm',
        'tc',
        'ts',
        'wm',
        'IQM',
        'WM',
        'PR',
        'TC',
        'TM',
        'TS',
      ].some((prefix) => updatedDefaults.statistic!.startsWith(prefix))
        ? {ExtendedStatistic: updatedDefaults.statistic}
        : {Statistic: updatedDefaults.statistic as Statistic}),
      Threshold: threshold,
      ActionsEnabled: false,
      Dimensions: [...dimensions],
      Tags: [{Key: 'severity', Value: classification}],
      TreatMissingData: updatedDefaults.missingDataTreatment,
    };

    const response = await cloudWatchClient.send(
      new PutMetricAlarmCommand(alarmInput),
    );
    log
      .info()
      .str('function', 'handleStaticThresholdWorkflow')
      .str('AlarmName', alarmName)
      .obj('response', response)
      .msg('Successfully created or updated static threshold alarm');
  } catch (e) {
    log
      .error()
      .str('function', 'handleStaticThresholdWorkflow')
      .str('AlarmName', alarmName)
      .err(e)
      .msg('Error creating or updating static threshold alarm');
    // Rethrow the error so it can be caught by the caller
    throw e;
  }
}

export async function handleStaticAlarms(
  config: MetricAlarmConfig,
  service: string,
  serviceIdentifier: string,
  dimensions: {Name: string; Value: string}[],
  updatedDefaults: MetricAlarmOptions,
  storagePath?: string,
): Promise<string[]> {
  const createdAlarms: string[] = [];

  // Validate if thresholds are set correctly
  const warningThresholdSet =
    updatedDefaults.warningThreshold !== undefined &&
    updatedDefaults.warningThreshold !== null;
  const criticalThresholdSet =
    updatedDefaults.criticalThreshold !== undefined &&
    updatedDefaults.criticalThreshold !== null;

  // If no thresholds are set, log and exit early
  if (!warningThresholdSet && !criticalThresholdSet && !config.defaultCreate) {
    const alarmPrefix = `AutoAlarm-ALB-${serviceIdentifier}-${config.metricName}`;
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('serviceIdentifier', serviceIdentifier)
      .str('alarm prefix: ', `${alarmPrefix}`)
      .msg(
        'No thresholds defined, skipping alarm creation and deleting alarms for config if they exist.',
      );
    await deleteAlarmsForConfig(
      config,
      service,
      serviceIdentifier,
      dimensions,
      updatedDefaults.statistic,
    );
    return createdAlarms;
  }

  updatedDefaults.period = validatePeriod(updatedDefaults.period);
  validateComparisonOperator(config, updatedDefaults, 'static');

  // Handle warning static alarm
  if (warningThresholdSet) {
    const warningAlarmName = buildAlarmName(
      config,
      service,
      serviceIdentifier,
      AlarmClassification.Warning,
      'static',
      storagePath,
    );
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('AlarmName', warningAlarmName)
      .msg('Creating or updating warning static alarms');
    await handleStaticThresholdWorkflow(
      warningAlarmName,
      updatedDefaults,
      config,
      dimensions,
      AlarmClassification.Warning,
      updatedDefaults.warningThreshold as number,
    );
    createdAlarms.push(warningAlarmName);
  } else {
    const warningAlarmName = buildAlarmName(
      config,
      service,
      serviceIdentifier,
      AlarmClassification.Warning,
      'static',
      storagePath,
    );
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('AlarmName', warningAlarmName)
      .msg('Deleting existing warning static alarm due to no threshold.');
    await deleteAlarm(warningAlarmName);
  }

  // Handle critical static alarm
  if (criticalThresholdSet) {
    const criticalAlarmName = buildAlarmName(
      config,
      service,
      serviceIdentifier,
      AlarmClassification.Critical,
      'static',
      storagePath,
    );
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('AlarmName', criticalAlarmName)
      .msg('Creating or updating critical static alarms');
    await handleStaticThresholdWorkflow(
      criticalAlarmName,
      updatedDefaults,
      config,
      dimensions,
      AlarmClassification.Critical,
      updatedDefaults.criticalThreshold as number,
    );
    createdAlarms.push(criticalAlarmName);
  } else {
    const criticalAlarmName = buildAlarmName(
      config,
      service,
      serviceIdentifier,
      AlarmClassification.Critical,
      'static',
      storagePath,
    );
    log
      .info()
      .str('function', 'handleStaticAlarms')
      .str('AlarmName', criticalAlarmName)
      .msg('Deleting existing critical static alarm due to no threshold.');
    await deleteAlarm(criticalAlarmName);
  }

  return createdAlarms;
}

/**
 * Retrieves all active CloudWatch auto alarms for a given instance and returns them as an array.
 * This array is typically used when the deleteCWAlarm function is called from within service module files.
 *
 * @param {string} serviceName - Service name (e.g., ec2, ecs, eks, rds)
 * @param {string} serviceIdentifier - Instance identifier used by CloudWatch to pull alarm information
 * @returns {Promise<string[]>} Array of alarm names to be used for deletion
 * @throws {Error} If fetching alarms fails
 *
 * @example Instance Identifier Formats:
 * - EC2: instanceID
 * - ECS: [TBD]
 * - EKS: [TBD]
 * - RDS: [TBD]
 */
export async function getCWAlarmsForInstance(
  serviceName: string,
  serviceIdentifier: string,
): Promise<string[]> {
  if (!serviceIdentifier) {
    log
      .error()
      .str('function', 'getCWAlarmsForInstance')
      .str('serviceName', serviceName)
      .msg(
        'Service identifier is empty. Refusing to fetch alarms by service-wide prefix',
      );
    throw new Error(
      `getCWAlarmsForInstance called with empty identifier for service ${serviceName}`,
    );
  }
  let nextToken: string | undefined = undefined;
  const activeAutoAlarms: MetricAlarm[] = [];
  let hasMorePages = true;

  try {
    log
      .info()
      .str('function', 'getCWAlarmsForInstance')
      .str('serviceName', serviceName)
      .str('serviceIdentifier', serviceIdentifier)
      .msg('Fetching alarms for instance');

    // Keep fetching until no more pages
    while (hasMorePages) {
      const describeAlarmsCommand: DescribeAlarmsCommand =
        new DescribeAlarmsCommand({
          AlarmNamePrefix: `AutoAlarm-${serviceName.toUpperCase()}-${serviceIdentifier}`,
          NextToken: nextToken,
          MaxRecords: 100,
        });

      const describeAlarmsResponse = await cloudWatchClient.send(
        describeAlarmsCommand,
      );

      // Accumulate alarms from this page
      if (describeAlarmsResponse.MetricAlarms) {
        activeAutoAlarms.push(...describeAlarmsResponse.MetricAlarms);
      }

      // Check if there are more pages
      if (!describeAlarmsResponse.NextToken) {
        hasMorePages = false;
      }
      nextToken = describeAlarmsResponse.NextToken;
    }

    const alarms = activeAutoAlarms.map((alarm) => alarm.AlarmName || '');
    log
      .info()
      .str('function', 'getCWAlarmsForInstance')
      .str(`${serviceName}`, serviceIdentifier)
      .obj('alarms', alarms)
      .msg('Fetched alarms for instance');
    return alarms;
  } catch (error) {
    log
      .error()
      .str('function', 'getCWAlarmsForInstance')
      .err(error)
      .str(`${serviceName}`, serviceIdentifier)
      .msg('Failed to fetch alarms for instance');
    throw new Error(`Failed to fetch alarms for instance: ${error as string}`);
  }
}
