import {
  CloudWatchClient,
  ComparisonOperator,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
  MetricDataQuery,
  PutAnomalyDetectorCommand,
  PutMetricAlarmCommand,
  Statistic,
} from '@aws-sdk/client-cloudwatch';
import {
  MetricAlarmConfig,
  MetricAlarmOptions,
  MissingDataTreatment,
} from './alarm-config.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import * as logging from '@nr1e/logging';
import {AnomalyAlarmProps} from './types.mjs';
import {AlarmClassification} from './enums.mjs';

const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const log = logging.getLogger('alarm-tools');
const cloudWatchClient = new CloudWatchClient({
  region,
  retryStrategy: retryStrategy,
});

export async function doesAlarmExist(alarmName: string): Promise<boolean> {
  const response = await cloudWatchClient.send(
    new DescribeAlarmsCommand({AlarmNames: [alarmName]}),
  );
  log
    .info()
    .str('function', 'doesAlarmExist')
    .str('alarmName', alarmName)
    .str('response', JSON.stringify(response))
    .msg('Checking if alarm exists');

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

async function deleteAlarm(alarmName: string) {
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

  const anomalyDetectorInput = {
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

  try {
    const alarmInput = {
      AlarmName: alarmName,
      ComparisonOperator: updatedDefaults.comparisonOperator,
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

    const response = await cloudWatchClient.send(
      new PutMetricAlarmCommand(alarmInput),
    );
    log
      .info()
      .str('function', 'handleAnomalyDetectionWorkflow')
      .str('AlarmName', alarmName)
      .obj('response', response)
      .msg('Successfully created or updated anomaly detection alarm');
  } catch (e) {
    log
      .error()
      .str('function', 'handleAnomalyDetectionWorkflow')
      .str('AlarmName', alarmName)
      .err(e)
      .msg('Error creating or updating anomaly detection alarm');
  }
}

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
    const alarmInput = {
      AlarmName: alarmName,
      ComparisonOperator: updatedDefaults.comparisonOperator,
      EvaluationPeriods: updatedDefaults.evaluationPeriods,
      MetricName: config.metricName,
      Namespace: config.metricNamespace,
      Period: updatedDefaults.period,
      ...(['p', 'tm', 'tc', 'ts', 'wm', 'iqm'].some((prefix) =>
        updatedDefaults.statistic.startsWith(prefix),
      )
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

// the following alarm udpate function will be later deleted and deprecated in favor of the functions above.
// returns true if the alarm needs to be updated whether it exists or does not. For Anomaly Detection CW alarms
export async function anomalyCWAlarmNeedsUpdate(
  alarmName: string,
  newProps: AnomalyAlarmProps,
): Promise<boolean> {
  try {
    const existingAlarm = await cloudWatchClient.send(
      new DescribeAlarmsCommand({AlarmNames: [alarmName]}),
    );

    if (existingAlarm.MetricAlarms && existingAlarm.MetricAlarms.length > 0) {
      const existingProps = existingAlarm.MetricAlarms[0];

      log
        .info()
        .str('function', 'anomalyCWAlarmNeedsUpdate')
        .str('alarmName', alarmName)
        .str('existingProps', JSON.stringify(existingProps))
        .str('newProps', JSON.stringify(newProps))
        .msg('Checking if anomaly detection alarm needs');

      if (
        existingProps.EvaluationPeriods !== newProps.evaluationPeriods ||
        existingProps.Period !== newProps.period ||
        existingProps.ExtendedStatistic !== newProps.extendedStatistic
      ) {
        log
          .info()
          .str('function', 'anomalyCWAlarmNeedsUpdate')
          .str('alarmName', alarmName)
          .str(
            'existingEvaluationPeriods',
            existingProps.EvaluationPeriods?.toString() || 'undefined',
          )
          .str(
            'newEvaluationPeriods',
            newProps.evaluationPeriods.toString() || 'undefined',
          )
          .str(
            'existingPeriod',
            existingProps.Period?.toString() || 'undefined',
          )
          .str('newPeriod', newProps.period.toString() || 'undefined')
          .str(
            'existingExtendedStatistic',
            existingProps.ExtendedStatistic || 'undefined',
          )
          .str('newExtendedStatistic', newProps.extendedStatistic)
          .msg('Anomaly Detection Alarm needs update');
        return true;
      }
    } else {
      log
        .info()
        .str('function', 'anomalyCWAlarmNeedsUpdate')
        .str('alarmName', alarmName)
        .msg('Anomaly Detection Alarm does not exist');
      return true;
    }

    log
      .info()
      .str('function', 'anomalyCWAlarmNeedsUpdate')
      .str('alarmName', alarmName)
      .msg('Anomaly Detection Alarm does not need update');
    return false;
  } catch (e) {
    log
      .error()
      .err(e)
      .str('function', 'anomalyCWAlarmNeedsUpdate')
      .msg('Failed to determine if anomaly detection alarm needs update:');
    throw new Error(
      'Failed to determine if anomaly detection alarm needs update.',
    );
  }
}

// returns true if the alarm needs to be updated whether it exists or does not. For Static threshold CW alarms
export async function staticCWAlarmNeedsUpdate(
  alarmName: string,
  threshold: number,
  statistic: Statistic | string,
  period: number,
  evaluationPeriods: number,
): Promise<boolean> {
  try {
    const existingAlarm = await cloudWatchClient.send(
      new DescribeAlarmsCommand({AlarmNames: [alarmName]}),
    );

    if (existingAlarm.MetricAlarms && existingAlarm.MetricAlarms.length > 0) {
      const existingProps = existingAlarm.MetricAlarms[0];

      const existingStatistic =
        existingProps.Statistic || existingProps.ExtendedStatistic;

      if (
        existingProps.Threshold !== threshold ||
        existingProps.EvaluationPeriods !== evaluationPeriods ||
        existingProps.Period !== period ||
        existingStatistic !== statistic
      ) {
        log
          .info()
          .str('alarmName', alarmName)
          .str(
            'existingThreshold',
            existingProps.Threshold?.toString() || 'undefined',
          )
          .str('newThreshold', threshold?.toString() || 'undefined')
          .str(
            'existingEvaluationPeriods',
            existingProps.EvaluationPeriods?.toString() || 'undefined',
          )
          .str(
            'newEvaluationPeriods',
            evaluationPeriods?.toString() || 'undefined',
          )
          .str(
            'existingPeriod',
            existingProps.Period?.toString() || 'undefined',
          )
          .str('newPeriod', period?.toString() || 'undefined')
          .str(
            'existingStatistic',
            existingStatistic?.toString() || 'undefined',
          )
          .str('newStatistic', statistic.toString() || 'undefined')
          .msg('Alarm needs update');
        return true;
      }
    } else {
      log.info().str('alarmName', alarmName).msg('Alarm does not exist');
      return true;
    }

    log.info().str('alarmName', alarmName).msg('Alarm does not need update');
    return false;
  } catch (e) {
    log.error().err(e).msg('Failed to determine if alarm needs update:');
    return false;
  }
}

//TODO: add parameter for anomaly detection threshold

export async function createOrUpdateAnomalyDetectionAlarm(
  alarmName: string,
  comparisonOperator: ComparisonOperator,
  dimensions: {Name: string; Value: string}[],
  metricName: string,
  namespace: string,
  extendedStatistic: string,
  period: number,
  evaluationPeriods: number,
  classification: AlarmClassification,
  missingDataTreatment: MissingDataTreatment,
  anomalyDetectionThreshold?: number,
) {
  if (period < 10) {
    period = 10;
    log
      .info()
      .str('function', 'createOrUpdateAnomalyDetectionAlarm')
      .num('period', period)
      .msg(
        'Period value less than 10 is not allowed, must be 10. Using default value of 10',
      );
  } else if (period < 30 || period <= 45) {
    period = 30;
    log
      .info()
      .str('function', 'createOrUpdateAnomalyDetectionAlarm')
      .num('period', period)
      .msg(
        'Period value is either 30, < 30, <= 45 or 30. Using default value of 30',
      );
  } else {
    period = Math.ceil(period / 60) * 60;
    log
      .info()
      .str('function', 'createOrUpdateAnomalyDetectionAlarm')
      .num('period', period)
      .msg(
        'Period value not 10 or 30 must be multiple of 60. Adjusted to nearest multiple of 60',
      );
  }
  //const alarmExists = await doesAlarmExist(alarmName);
  //if (
  //  !alarmExists ||
  //  (alarmExists && (await anomalyCWAlarmNeedsUpdate(alarmName, newProps)))
  //) {
  try {
    // Create anomaly detector with the latest parameters
    const anomalyDetectorInput = {
      Namespace: namespace,
      MetricName: metricName,
      Dimensions: dimensions,
      Stat: extendedStatistic,
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
      ComparisonOperator: comparisonOperator,
      EvaluationPeriods: evaluationPeriods,

      Metrics: [
        {
          Id: 'primaryMetric',
          MetricStat: {
            Metric: {
              Namespace: namespace,
              MetricName: metricName,
              Dimensions: dimensions,
            },
            Period: period,
            Stat: extendedStatistic,
          },
        },
        {
          Id: 'anomalyDetectionBand',
          Expression: anomalyDetectionThreshold
            ? `ANOMALY_DETECTION_BAND(primaryMetric, ${anomalyDetectionThreshold})`
            : `ANOMALY_DETECTION_BAND(primaryMetric)`,
        },
      ],
      ThresholdMetricId: 'anomalyDetectionBand',
      ActionsEnabled: false,
      Tags: [{Key: 'severity', Value: classification}],
      TreatMissingData: missingDataTreatment, // Adjust as needed
    };

    log
      .info()
      .str('function', 'createOrUpdateAnomalyDetectionAlarm')
      .str('alarmName', alarmName)
      .obj('metric alarm input', metricAlarmInput)
      .msg('Attempting to create or update anomaly detection alarm');

    await cloudWatchClient.send(new PutMetricAlarmCommand(metricAlarmInput));

    log
      .info()
      .str('function', 'createOrUpdateAnomalyDetectionAlarm')
      .str('alarmName', alarmName)
      .obj('Dimesntions', dimensions)
      .msg(`${alarmName} Anomaly Detection Alarm created or updated.`);
  } catch (e) {
    log
      .error()
      .str('function', 'createOrUpdateAnomalyDetectionAlarm')
      .err(e)
      .str('alarmName', alarmName)
      .obj('Dimesntions', dimensions)
      .msg(
        `Failed to create or update ${alarmName} anomaly detection alarm due to an error ${e}`,
      );
  }
  //}
}

// This function is used to create or update a CW alarm based on the provided values.
export async function createOrUpdateCWAlarm(
  alarmName: string,
  serviceIdentifier: string,
  comparisonOperator: ComparisonOperator,
  threshold: number,
  period: number,
  evaluationPeriods: number,
  metricName: string,
  namespace: string,
  dimensions: {Name: string; Value: string}[],
  severityType: AlarmClassification,
  missingDataTreatment: MissingDataTreatment, // Default to 'ignore' if not specified
  statistic: Statistic | string,
) {
  const extendedStatRegex = /^p.*|^tm.*|^tc.*|^ts.*|^wm.*|^IQM$/;
  try {
    log
      .info()
      .str('function', 'createOrUpdateCWAlarm')
      .str('alarmName', alarmName)
      .str('Service Identifier', serviceIdentifier)
      .num('threshold', threshold)
      .num('period', period)
      .num('evaluationPeriods', evaluationPeriods)
      .msg('Configuring alarm props from provided values');

    if (period < 10) {
      period = 10;
      log
        .info()
        .str('function', 'createOrUpdateCWAlarm')
        .num('period', period)
        .msg(
          'Period value less than 10 is not allowed, must be 10. Using default value of 10',
        );
    } else if (period < 30 || period <= 45) {
      period = 30;
      log
        .info()
        .str('function', 'createOrUpdateCWAlarm')
        .num('period', period)
        .msg(
          'Period value is either 30, < 30, <= 45 or 30. Using default value of 30',
        );
    } else {
      period = Math.ceil(period / 60) * 60;
      log
        .info()
        .str('function', 'createOrUpdateCWAlarm')
        .num('period', period)
        .msg(
          'Period value not 10 or 30 must be multiple of 60. Adjusted to nearest multiple of 60',
        );
    }

    log
      .info()
      .str('function', 'createOrUpdateCWAlarm')
      .str('alarmName', alarmName)
      .str('Service Identifier', serviceIdentifier)
      .num('threshold', threshold)
      .num('period', period)
      .num('evaluationPeriods', evaluationPeriods)
      .msg('Alarm props configured from provided values');
  } catch (e) {
    log
      .error()
      .str('function', 'createOrUpdateCWAlarm')
      .err(e)
      .msg('Error configuring alarm props from provided values');
    throw new Error('Error configuring alarm props from provided values');
  }
  /* Removed the logic to check if alarm exists because we should just replace the alarm every time. It's only a single API call. Leaving here for testing.
   *const alarmExists = await doesAlarmExist(alarmName);
   *if (
   *  !alarmExists ||
   *  (alarmExists &&
   *    (await staticCWAlarmNeedsUpdate(
   *      alarmName,
   *      threshold,
   *      statistic,
   *      period,
   *      evaluationPeriods,
   *    )))
   *) {
   */
  const metricAlarmInput = {
    AlarmName: alarmName,
    ComparisonOperator: comparisonOperator,
    EvaluationPeriods: evaluationPeriods,
    MetricName: metricName,
    Namespace: namespace,
    Period: period,
    ...(extendedStatRegex.test(statistic)
      ? {ExtendedStatistic: statistic}
      : {Statistic: statistic as Statistic}),
    Threshold: threshold,
    ActionsEnabled: false,
    Dimensions: dimensions,
    Tags: [{Key: 'severity', Value: severityType}],
    TreatMissingData: missingDataTreatment,
  };

  try {
    log
      .info()
      .str('function', 'createOrUpdateCWAlarm')
      .str('alarmName', alarmName)
      .obj('metricAlarmInput', metricAlarmInput)
      .msg('Attempting to Create or update alarm');

    await cloudWatchClient.send(new PutMetricAlarmCommand(metricAlarmInput));
    log
      .info()
      .str('function', 'createOrUpdateCWAlarm')
      .str('alarmName', alarmName)
      .str('serviceIdentifier', serviceIdentifier)
      .num('threshold', threshold)
      .num('period', period)
      .num('evaluationPeriods', evaluationPeriods)
      .msg(`${alarmName} Alarm configured or updated.`);
  } catch (e) {
    log
      .error()
      .str('function', 'createOrUpdateCWAlarm')
      .err(e)
      .str('alarmName', alarmName)
      .str('instanceId', serviceIdentifier)
      .msg(
        `Failed to create or update ${alarmName} alarm due to an error ${e}`,
      );
  }
  //} //related to if statement on line 404
}

// This function is used to grab all active CW auto alarms for a given instance and then pushes those to the activeAutoAlarms array
// which it returns to be used when the deleteCWAlarm function is called from within service module files.
// service identifier should be lowercase e.g. ec2, ecs, eks, rds, etc.
// serviceIdentifier should be all UPPER CASE
// instance identifier should be the identifier that is use for cloudwatch to pull alarm information. When adding a new service
// list it here below:
// EC2: instanceID
// ECS: ...
// EKS: ...
// RDS: ...
export async function getCWAlarmsForInstance(
  serviceIdentifier: string,
  instanceIdentifier: string,
): Promise<string[]> {
  const activeAutoAlarms: string[] = [];
  try {
    const describeAlarmsCommand = new DescribeAlarmsCommand({});
    const describeAlarmsResponse = await cloudWatchClient.send(
      describeAlarmsCommand,
    );
    const alarms = describeAlarmsResponse.MetricAlarms || [];

    // Filter alarms by name prefix
    log
      .info()
      .str('function', 'getCWAlarmsForInstance')
      .str('serviceIdentifier', serviceIdentifier)
      .str('instanceIdentifier', instanceIdentifier)
      .str(
        'alarm prefix',
        `AutoAlarm-${serviceIdentifier}-${instanceIdentifier}`,
      )
      .msg('Filtering alarms by name');
    const instanceAlarms = alarms.filter(
      (alarm) =>
        alarm.AlarmName &&
        (alarm.AlarmName.startsWith(
          `AutoAlarm-${serviceIdentifier}-${instanceIdentifier}`,
        ) ||
          alarm.AlarmName.startsWith(
            `AutoAlarm-${serviceIdentifier}-${instanceIdentifier}-Anomaly`,
          ) ||
          alarm.AlarmName.startsWith(
            `AutoAlarm-${serviceIdentifier}-${instanceIdentifier}`,
          )),
    );

    // Push the alarm names to activeAutoAlarmAlarms, ensuring AlarmName is defined
    activeAutoAlarms.push(
      ...instanceAlarms
        .map((alarm) => alarm.AlarmName)
        .filter((alarmName): alarmName is string => !!alarmName),
    );

    log
      .info()
      .str('function', 'getCWAlarmsForInstance')
      .str(`${serviceIdentifier}`, instanceIdentifier)
      .str('alarms', JSON.stringify(instanceAlarms))
      .msg('Fetched alarms for instance');

    return activeAutoAlarms;
  } catch (error) {
    log
      .error()
      .str('function', 'getCWAlarmsForInstance')
      .err(error)
      .str(`${serviceIdentifier}`, instanceIdentifier)
      .msg('Failed to fetch alarms for instance');
    return [];
  }
}

export async function deleteCWAlarm(
  alarmName: string,
  instanceIdentifier: string,
): Promise<void> {
  log
    .info()
    .str('function', 'deleteCWAlarm')
    .str('alarmName', alarmName)
    .msg('checking if alarm exists...');
  const alarmExists = await doesAlarmExist(alarmName);
  if (alarmExists) {
    log
      .info()
      .str('function', 'deleteCWAlarm')
      .str('alarmName', alarmName)
      .str('instanceId', instanceIdentifier)
      .msg('Attempting to delete alarm');
    await cloudWatchClient.send(
      new DeleteAlarmsCommand({AlarmNames: [alarmName]}),
    );
    log
      .info()
      .str('function', 'deleteCWAlarm')
      .str('alarmName', alarmName)
      .str('instanceId', instanceIdentifier)
      .msg('Deleted alarm');
  } else {
    log
      .info()
      .str('function', 'deleteCWAlarm')
      .str('alarmName', alarmName)
      .str('instanceId', instanceIdentifier)
      .msg('Alarm does not exist for instance');
  }
}
