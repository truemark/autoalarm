import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
  DescribeAlarmsCommandOutput,
  MetricAlarm,
  MetricDataQuery,
  PutAnomalyDetectorCommand,
  PutAnomalyDetectorCommandInput,
  PutMetricAlarmCommand,
  PutMetricAlarmCommandInput,
  Statistic,
} from '@aws-sdk/client-cloudwatch';
import {ComparisonOperator} from 'aws-cdk-lib/aws-cloudwatch';
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

export async function deleteExistingAlarms(
  service: string,
  identifier: string,
) {
  log
    .info()
    .str('function', 'deleteExistingAlarms')
    .str('Service', service)
    .str('Identifier', identifier)
    .msg('Fetching and deleting existing alarms');
  const activeAutoAlarms = await getCWAlarmsForInstance(service, identifier);

  log
    .info()
    .str('function', 'deleteExistingAlarms')
    .obj('AlarmName', activeAutoAlarms)
    .msg('Deleting alarm');
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({
      AlarmNames: [...activeAutoAlarms],
    }),
  );
}

async function deleteAlarmsForConfig(
  config: MetricAlarmConfig,
  service: string,
  serviceIdentifier: string,
) {
  for (const classification of Object.values(AlarmClassification)) {
    for (const alarmVariant of ['static', 'anomaly'] as const) {
      const alarmName = buildAlarmName(
        config,
        service,
        serviceIdentifier,
        classification,
        alarmVariant,
      );
      await deleteAlarm(alarmName);
    }
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
  log
    .info()
    .str('function', 'massDeleteAlarms')
    .str('AlarmNames', JSON.stringify(alarmNames))
    .msg('Attempting to delete alarms');
  try {
    await cloudWatchClient.send(
      new DeleteAlarmsCommand({AlarmNames: alarmNames}),
    );
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
  }
}

export function buildAlarmName(
  config: MetricAlarmConfig,
  service: string,
  serviceIdentifier: string,
  classification: AlarmClassification,
  alarmVarient: 'anomaly' | 'static',
  storagePath?: string,
) {
  if (storagePath) {
    const alarmName =
      alarmVarient === 'anomaly'
        ? `AutoAlarm-${service}-${serviceIdentifier}-${config.metricName}-${storagePath}-anomaly-${classification}`
        : `AutoAlarm-${service}-${serviceIdentifier}-${config.metricName}-${storagePath}-${classification}`;
    log
      .info()
      .str('function', 'buildAlarmName')
      .str('AlarmName', alarmName)
      .msg('Built alarm name name');
    return alarmName;
  } else {
    const alarmName =
      alarmVarient === 'anomaly'
        ? `AutoAlarm-${service}-${serviceIdentifier}-${config.metricName}-anomaly-${classification}`
        : `AutoAlarm-${service}-${serviceIdentifier}-${config.metricName}-${classification}`;
    log
      .info()
      .str('function', 'buildAlarmName')
      .str('AlarmName', alarmName)
      .msg('Built alarm name name');
    return alarmName;
  }
}

// used as input validation to ensure that the period value is always a valid number for the cloudwatch api
function validatePeriod(period: number) {
  if (period < 10) {
    log
      .info()
      .str('function', 'validatePeriod')
      .str('period', period.toString())
      .msg('Period is less than 10, setting to 10');
    return 10;
  } else if (period < 30 || period <= 45) {
    log
      .info()
      .str('function', 'validatePeriod')
      .str('period', period.toString())
      .msg('Period is less than 30 or less than or equal to 45, setting to 30');
    return 30;
  } else if (period > 45 && period % 60 !== 0) {
    log
      .info()
      .str('function', 'validatePeriod')
      .str('period', period.toString())
      .msg('Period is greater than 45, setting to nearest multiple of 60');
    return Math.ceil(period / 60) * 60;
  } else {
    log
      .info()
      .str('function', 'validatePeriod')
      .str('period', period.toString())
      .msg('Period is valid');
    return period;
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

    log
      .debug()
      .str('function', 'handleAnomalyDetectionWorkflow')
      .obj('AnomalyDetectorInput', anomalyDetectorInput)
      .msg('Sending PutAnomalyDetectorCommand');
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

    const alarmInput = {
      AlarmName: alarmName,
      ComparisonOperator:
        updatedDefaults.comparisonOperator as ComparisonOperator,
      EvaluationPeriods: updatedDefaults.evaluationPeriods,
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
    const alarmPrefix = `AutoAlarm-ALB-${serviceIdentifier}-${config.metricName}-anomaly-`;
    log
      .info()
      .str('function', 'handleAnomalyAlarms')
      .str('Service Identifier', serviceIdentifier)
      .str('alarm prefix: ', alarmPrefix)
      .msg(
        'No thresholds defined, skipping alarm creation and deleting alarms for config if they exist.',
      );
    await deleteAlarmsForConfig(config, service, serviceIdentifier);
    return createdAlarms;
  }

  updatedDefaults.period = validatePeriod(updatedDefaults.period);

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

    log
      .debug()
      .str('function', 'handleStaticThresholdWorkflow')
      .obj('AlarmInput', alarmInput)
      .msg('Sending PutMetricAlarmCommand');
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
    await deleteAlarmsForConfig(config, service, serviceIdentifier);
    return createdAlarms;
  }

  updatedDefaults.period = validatePeriod(updatedDefaults.period);

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
