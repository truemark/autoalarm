export type MissingDataTreatment =
  | 'missing'
  | 'ignore'
  | 'breaching'
  | 'notBreaching';
export type ComparisonOperator =
  | 'GreaterThanOrEqualToThreshold'
  | 'GreaterThanThreshold'
  | 'LessThanThreshold'
  | 'LessThanOrEqualToThreshold'
  | 'LessThanLowerOrGreaterThanUpperThreshold'
  | 'LessThanLowerThreshold'
  | 'GreaterThanUpperThreshold';

// Note that these apply to both anomaly and non-anomaly alarms in CloudWatch.
export interface MetricAlarmOptions {
  // Anomaly: Based on a standard deviation. Higher number means thicker band, lower number means thinner band.
  // Non-Anomaly: The value against which the specified statistic is compared.
  warningThreshold: number | null;

  // Anomaly: Based on a standard deviation. Higher number means thicker band, lower number means thinner band.
  // Non-Anomaly: The value against which the specified statistic is compared.
  criticalThreshold: number | null;

  // The period, in seconds, over which the statistic is applied.
  period: number;

  // The number of periods over which data is compared to the specified threshold.
  evaluationPeriods: number;

  // Data points to alarm
  dataPointsToAlarm: number;

  // The statistic or extended statistic for the metric associated with the alarm
  statistic: string;

  // Missing data treatment
  missingDataTreatment: MissingDataTreatment;

  // The arithmetic operation to use when comparing the specified statistic and threshold
  comparisonOperator: ComparisonOperator;
}

export function metricAlarmOptionsToString(value: MetricAlarmOptions): string {
  return (
    (value.warningThreshold ? value.warningThreshold : '-') +
    '/' +
    (value.criticalThreshold ? value.criticalThreshold : '-') +
    '/' +
    value.period +
    '/' +
    value.evaluationPeriods +
    '/' +
    value.statistic +
    '/' +
    value.dataPointsToAlarm +
    '/' +
    value.comparisonOperator +
    '/' +
    value.missingDataTreatment
  );
}

function parseThresholdOption(
  value: string,
  defaultValue: number | null,
): number | null {
  const trimmed = value.trim();
  if (trimmed === '-') {
    return null;
  }
  if (trimmed === '') {
    return defaultValue;
  }
  const parsedValue = parseFloat(trimmed);

  if (isNaN(parsedValue)) {
    return defaultValue;
  }

  return parsedValue;
}

function parseIntegerOption(value: string, defaultValue: number): number {
  const trimmed = value.trim();
  if (trimmed === '') {
    return defaultValue;
  }
  const parsedValue = parseFloat(trimmed);

  if (isNaN(parsedValue)) {
    return defaultValue;
  }

  return parsedValue;
}

function parseStatisticOption(value: string, defaultValue: string): string {
  const regexp = /^p.*|^tm.*|^tc.*|^ts.*|^wm.*|^iqm$/;
  const statistics = ['SampleCount', 'Average', 'Sum', 'Minimum', 'Maximum'];
  const statisticsRecord: Record<string, string> = {};
  for (const statistic of statistics) {
    statisticsRecord[statistic.toLowerCase()] = statistic;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') {
    return defaultValue;
  }
  if (statisticsRecord[trimmed]) {
    return statisticsRecord[trimmed];
  }
  if (trimmed.match(regexp)) {
    return trimmed;
  }
  return defaultValue;
}

function parseComparisonOperatorOption(
  value: string,
  defaultValue: ComparisonOperator,
): ComparisonOperator {
  const operators: ComparisonOperator[] = [
    'GreaterThanOrEqualToThreshold',
    'GreaterThanThreshold',
    'LessThanThreshold',
    'LessThanOrEqualToThreshold',
    'LessThanLowerOrGreaterThanUpperThreshold',
    'LessThanLowerThreshold',
    'GreaterThanUpperThreshold',
  ];
  const operatorsRecord: Record<string, ComparisonOperator> = {};
  for (const operator of operators) {
    operatorsRecord[operator.toLowerCase()] = operator;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') {
    return defaultValue;
  }
  if (operatorsRecord[trimmed]) {
    return operatorsRecord[trimmed];
  }
  return defaultValue;
}

function parseMissingDataTreatmentOption(
  value: string,
  defaultValue: MissingDataTreatment,
): MissingDataTreatment {
  const treatments: MissingDataTreatment[] = [
    'missing',
    'ignore',
    'breaching',
    'notBreaching',
  ];
  const treatmentsRecord: Record<string, MissingDataTreatment> = {};
  for (const treatment of treatments) {
    treatmentsRecord[treatment.toLowerCase()] = treatment;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') {
    return defaultValue;
  }
  if (treatmentsRecord[trimmed]) {
    return treatmentsRecord[trimmed];
  }
  return defaultValue;
}

export function parseMetricAlarmOptions(
  value: string,
  defaults: MetricAlarmOptions,
): MetricAlarmOptions {
  const parts = value.split('/');
  return {
    warningThreshold:
      parts.length > 0
        ? parseThresholdOption(parts[0], defaults.warningThreshold)
        : defaults.warningThreshold,
    criticalThreshold:
      parts.length > 1
        ? parseThresholdOption(parts[1], defaults.criticalThreshold)
        : defaults.criticalThreshold,
    period:
      parts.length > 2
        ? parseIntegerOption(parts[2], defaults.period)
        : defaults.period,
    evaluationPeriods:
      parts.length > 3
        ? parseIntegerOption(parts[3], defaults.evaluationPeriods)
        : defaults.evaluationPeriods,
    statistic:
      parts.length > 4
        ? parseStatisticOption(parts[4], defaults.statistic)
        : defaults.statistic,
    dataPointsToAlarm:
      parts.length > 5
        ? parseIntegerOption(parts[5], defaults.dataPointsToAlarm)
        : defaults.dataPointsToAlarm,
    comparisonOperator:
      parts.length > 6
        ? parseComparisonOperatorOption(parts[6], defaults.comparisonOperator)
        : defaults.comparisonOperator,
    missingDataTreatment:
      parts.length > 7
        ? parseMissingDataTreatmentOption(
            parts[7],
            defaults.missingDataTreatment,
          )
        : defaults.missingDataTreatment,
  };
}

export interface MetricAlarmConfig {
  tagKey: string;
  metricName: string;
  metricNamespace: string;
  defaultCreate: boolean;
  anomaly: boolean;
  defaults: MetricAlarmOptions;
}

// You are expected to collaborate and get approval from the team lead for each team that owns the service
// to determine the appropriate alarm configurations. Do not make assumptions and ensure any alarm configurations
// are approved by the team lead. At the end of the day, the team lead is responsible for the service and the alarms.
export const MetricAlarmConfigs: Record<string, MetricAlarmConfig[]> = {
  // Keep these in alphabetical order or your PRs will be rejected
  // Anomaly alarms can only use the following comparison operators: GreaterThanUpperThreshold, LessThanLowerOrGreaterThanUpperThreshold, LessThanLowerThreshold
  // Owned by Harmony
  ALB: [
    // TODO Add remaining alarms and get buy off from team lead on PR
    {
      tagKey: '4xx-count',
      metricName: 'HTTPCode_Target_4XX_Count',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Sum',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: '4xx-count-anomaly',
      metricName: 'HTTPCode_Target_4XX_Count',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: '5xx-count',
      metricName: 'HTTPCode_Target_5XX_Count',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Sum',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: '5xx-count-anomaly',
      metricName: 'HTTPCode_Target_5XX_Count',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'request-count',
      metricName: 'RequestCount',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Sum',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'request-count-anomaly',
      metricName: 'RequestCount',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 3,
        criticalThreshold: 5,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    //TODO: Add target response times
  ],
  CloudFront: [
    //TODO: Add alarms and get buy off from team lead on PR
    {
      tagKey: '4xx-errors',
      metricName: '4xxErrorRate',
      metricNamespace: 'AWS/CloudFront',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 5, // Adjust threshold based on your needs
        criticalThreshold: 10, // Adjust threshold based on your needs
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: '4xx-errors-anomaly',
      metricName: '4xxErrorRate',
      metricNamespace: 'AWS/CloudFront',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: '5xx-errors',
      metricName: '5xxErrorRate',
      metricNamespace: 'AWS/CloudFront',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 1,
        criticalThreshold: 5,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: '5xx-errors-anomaly',
      metricName: '5xxErrorRate',
      metricNamespace: 'AWS/CloudFront',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
  ],
  // Owned by Harmony
  EC2: [
    // TODO Add alarms and get buy off from team lead on PR
    {
      tagKey: 'cpu',
      metricName: 'CPUUtilization',
      metricNamespace: 'AWS/EC2',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 95,
        criticalThreshold: 98,
        period: 60,
        evaluationPeriods: 5,
        statistic: 'Maximum',
        dataPointsToAlarm: 5,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'cpu-anomaly',
      metricName: 'CPUUtilization',
      metricNamespace: 'AWS/EC2',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 60,
        evaluationPeriods: 5,
        statistic: 'Average',
        dataPointsToAlarm: 5,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'memory',
      metricName: '', // Empty string to account for divergent metric names between windows and linux instances for EC2 storage and memory configs. Assigned programmatically in ec2-modules.
      metricNamespace: 'CWAgent',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 95,
        criticalThreshold: 98,
        period: 60,
        evaluationPeriods: 10,
        statistic: 'Maximum',
        dataPointsToAlarm: 10,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'memory-anomaly',
      metricName: '', // Empty string to account for divergent metric names between windows and linux instances for EC2 storage and memory configs. Assigned programmatically in ec2-modules.
      metricNamespace: 'CWAgent',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'storage',
      metricName: '', // Empty string to account for divergent metric names between windows and linux instances for EC2 storage and memory configs. Assigned programmatically in ec2-modules.
      metricNamespace: 'CWAgent',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 90,
        criticalThreshold: 95,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'storage-anomaly',
      metricName: '', // Empty string to account for divergent metric names between windows and linux instances for EC2 storage and memory configs. Assigned programmatically in ec2-modules.
      metricNamespace: 'CWAgent',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 3,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    // TODO: network in and out still need to be passed off by devops
    //  and are disabled by default and not referenced in README.
    //  construct does not currently listen for tags on these.
    {
      tagKey: 'network-in',
      metricName: 'NetworkIn',
      metricNamespace: 'AWS/EC2',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 5,
        statistic: 'Sum',
        dataPointsToAlarm: 5,
        comparisonOperator: 'LessThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'network-in-anomaly',
      metricName: 'NetworkIn',
      metricNamespace: 'AWS/EC2',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 60,
        evaluationPeriods: 5,
        statistic: 'Average',
        dataPointsToAlarm: 5,
        comparisonOperator: 'LessThanLowerThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'network-out',
      metricName: 'NetworkOut',
      metricNamespace: 'AWS/EC2',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 5,
        statistic: 'Sum',
        dataPointsToAlarm: 5,
        comparisonOperator: 'LessThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'network-out-anomaly',
      metricName: 'NetworkOut',
      metricNamespace: 'AWS/EC2',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 60,
        evaluationPeriods: 5,
        statistic: 'Average',
        dataPointsToAlarm: 5,
        comparisonOperator: 'LessThanLowerThreshold',
        missingDataTreatment: 'ignore',
      },
    },
  ],
  // Owned by Harmony
  // TODO Once these are settled, please get an issue recorded in the overwatch repo to enable AutoAlarm tags for OpenSearch for Trent / Fouad to implement.
  OpenSearch: [
    {
      tagKey: '4xx-errors',
      metricName: '4xx',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: 100,
        criticalThreshold: 300,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO I don't think this should be set by default, but discuss with Trent and have him decide.
      tagKey: '4xx-errors-anomaly',
      metricName: '4xx',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: '5xx-errors',
      metricName: '5xx',
      metricNamespace: 'AWS/ES',
      defaultCreate: true, // TODO I think I would enable this by default
      anomaly: false,
      defaults: {
        warningThreshold: 10, // TODO This threshold make no sense to me
        criticalThreshold: 50, // TODO This threshold make no sense to me
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: '5xx-errors-anomaly',
      metricName: '5xx',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'cpu',
      metricName: 'CPUUtilization',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 98,
        criticalThreshold: 98,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'cpu-anomaly',
      metricName: 'CPUUtilization',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 2,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'iops-throttle',
      metricName: 'IopsThrottle',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 5,
        criticalThreshold: 10,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'iops-throttle-anomaly',
      metricName: 'IopsThrottle',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'jvm-memory',
      metricName: 'JVMMemoryPressure',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 90,
        criticalThreshold: 95,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'jvm-memory-anomaly',
      metricName: 'JVMMemoryPressure',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO I would have this enabled by default with high reasonable defaults
      tagKey: 'read-latency',
      metricName: 'ReadLatency',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 0.03,
        criticalThreshold: 0.08,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Maximum',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'read-latency-anomaly',
      metricName: 'ReadLatency',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 6,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    // TODO: temp until we reevaluate. Might need thresholds to be .5/1
    {
      tagKey: 'search-latency',
      metricName: 'SearchLatency',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 4,
        period: 300,
        evaluationPeriods: 4,
        statistic: 'Average',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'search-latency-anomaly',
      metricName: 'SearchLatency',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'snapshot-failure',
      metricName: 'AutomatedSnapshotFailure',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: 1,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    //Under advisement from Trent, anomaly detection is not recommended for snaptshot-failure
    {
      tagKey: 'storage',
      metricName: 'FreeStorageSpace',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        //Threshold are in MegaBytes
        warningThreshold: 10000,
        criticalThreshold: 5000,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'SUM',
        dataPointsToAlarm: 2,
        comparisonOperator: 'LessThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'storage-anomaly',
      metricName: 'FreeStorageSpace',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 3,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'SUM',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    // TODO: Under advisement from Trent, sysMemoryUtilization is not recommended as memory util is by standard > 90%. Both for anomaly and static. Recommended to remove metric memory pressure might suffice
    {
      tagKey: 'throughput-throttle',
      metricName: 'ThroughputThrottle',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: 40,
        criticalThreshold: 60,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Sum',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'throughput-throttle-anomaly',
      metricName: 'ThroughputThrottle',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 3,
        criticalThreshold: 5,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO I think this should be enabled by default. Discuss with Trent and get his decision.
      tagKey: 'write-latency',
      metricName: 'WriteLatency',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 84,
        criticalThreshold: 100,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Maximum',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'write-latency-anomaly',
      metricName: 'WriteLatency',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'yellow-cluster',
      metricName: 'ClusterStatus.yellow',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: 1,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    //TODO: Under advisement from Trent, anomaly detection is not recommended for yellow-cluster
    {
      tagKey: 'red-cluster',
      metricName: 'ClusterStatus.red',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: 1,
        period: 60,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    //TODO: Under advisement from Trent, anomaly detection is not recommended for red-cluster
  ],

  // Owned by Harmony
  OpenSearchServerless: [
    // TODO Add alarms and get buy off from team lead on PR
  ],
  // Owned by DB Warden
  RDSCluster: [
    // 1) CPU - Static Only
    {
      tagKey: 'cpu',
      metricName: 'CPUUtilization',
      metricNamespace: 'AWS/RDS',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: 90,
        criticalThreshold: 95,
        period: 600,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 2) DatabaseConnections - Anomaly

    {
      tagKey: 'db-connections-anomaly',
      metricName: 'DatabaseConnections',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 600,
        evaluationPeriods: 5,
        statistic: 'Average',
        dataPointsToAlarm: 5,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 3) DBLoad - Anomaly Only
    {
      tagKey: 'dbload-anomaly',
      metricName: 'DBLoad',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 4) Deadlocks - Static
    {
      tagKey: 'deadlocks',
      metricName: 'Deadlocks',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 0,
        criticalThreshold: 0,
        period: 120,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 5) FreeableMemory - Static Only
    {
      tagKey: 'freeable-memory',
      metricName: 'FreeableMemory',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 2000000000,
        criticalThreshold: 100000000,
        period: 120,
        evaluationPeriods: 2,
        statistic: 'Maximum',
        dataPointsToAlarm: 2,
        comparisonOperator: 'LessThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 7) ReplicaLag - Static + Anomaly
    {
      tagKey: 'replica-lag',
      metricName: 'ReplicaLag',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 60,
        criticalThreshold: 300,
        period: 120,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'replica-lag-anomaly',
      metricName: 'ReplicaLag',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 120,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 8) SwapUsage - Anomaly Only
    {
      tagKey: 'swap-usage-anomaly',
      metricName: 'SwapUsage',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 120,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 9) WriteLatency - Anomaly

    {
      tagKey: 'write-latency-anomaly',
      metricName: 'WriteLatency',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 6,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
  ],

  RDS: [
    // 1) CPU - Static Only
    {
      tagKey: 'cpu',
      metricName: 'CPUUtilization',
      metricNamespace: 'AWS/RDS',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: 90,
        criticalThreshold: 95,
        period: 600,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 2) DatabaseConnections - Anomaly

    {
      tagKey: 'db-connections-anomaly',
      metricName: 'DatabaseConnections',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 600,
        evaluationPeriods: 5,
        statistic: 'Average',
        dataPointsToAlarm: 5,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 3) DBLoad - Anomaly Only
    {
      tagKey: 'dbload-anomaly',
      metricName: 'DBLoad',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 4) Deadlocks - Static
    {
      tagKey: 'deadlocks',
      metricName: 'Deadlocks',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 0,
        criticalThreshold: 0,
        period: 120,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 5) FreeableMemory - Static Only
    {
      tagKey: 'freeable-memory',
      metricName: 'FreeableMemory',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 2000000000,
        criticalThreshold: 100000000,
        period: 120,
        evaluationPeriods: 2,
        statistic: 'Maximum',
        dataPointsToAlarm: 2,
        comparisonOperator: 'LessThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 7) ReplicaLag - Static + Anomaly
    {
      tagKey: 'replica-lag',
      metricName: 'ReplicaLag',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 60,
        criticalThreshold: 300,
        period: 120,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'replica-lag-anomaly',
      metricName: 'ReplicaLag',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 120,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 8) SwapUsage - Anomaly Only
    {
      tagKey: 'swap-usage-anomaly',
      metricName: 'SwapUsage',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 120,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },

    // 9) WriteLatency - Anomaly

    {
      tagKey: 'write-latency-anomaly',
      metricName: 'WriteLatency',
      metricNamespace: 'AWS/RDS',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 6,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
  ],

  R53ResolverEndpoint: [
    {
      tagKey: 'inbound-query-volume',
      metricName: 'InboundQueryVolume',
      metricNamespace: 'AWS/Route53Resolver',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 1500000,
        criticalThreshold: 2000000,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'inbound-query-volume-anomaly',
      metricName: 'InboundQueryVolume',
      metricNamespace: 'AWS/Route53Resolver',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'outbound-query-volume',
      metricName: 'OutboundQueryAggregateVolume',
      metricNamespace: 'AWS/Route53Resolver',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 1500000,
        criticalThreshold: 2000000,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'outbound-query-volume-anomaly',
      metricName: 'OutboundQueryAggregateVolume',
      metricNamespace: 'AWS/Route53Resolver',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
  ],
  // Owned by Harmony
  SNS: [
    // TODO Add alarms and get buy off from team lead on PR
  ],
  // Owned by Harmony
  SQS: [
    {
      tagKey: 'age-of-oldest-message',
      metricName: 'ApproximateAgeOfOldestMessage',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'age-of-oldest-message-anomaly',
      metricName: 'ApproximateAgeOfOldestMessage',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'empty-recieves',
      metricName: 'NumberOfEmptyReceive',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'empty-recieves-anomaly',
      metricName: 'NumberOfEmptyReceive',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'messages-deleted',
      metricName: 'NumberOfMessagesDeleted',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'messages-deleted-anomaly',
      metricName: 'NumberOfMessagesDeleted',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'messages-not-visible',
      metricName: 'ApproximateNumberOfMessagesNotVisible',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'messages-not-visible-anomaly',
      metricName: 'ApproximateNumberOfMessagesNotVisible',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'messages-received',
      metricName: 'NumberOfMessagesReceived',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'messages-received-anomaly',
      metricName: 'NumberOfMessagesReceived',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'messages-sent',
      metricName: 'NumberOfMessagesSent',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'messages-sent-anomaly',
      metricName: 'NumberOfMessagesSent',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 1,
        criticalThreshold: 1,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'messages-visible',
      metricName: 'ApproximateNumberOfMessagesVisible',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'messages-visible-anomaly',
      metricName: 'ApproximateNumberOfMessagesVisible',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'number-of-messages-delayed',
      metricName: 'ApproximateNumberOfMessagesDelayed',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'number-of-messages-delayed-anomaly',
      metricName: 'ApproximateNumberOfMessagesDelayed',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'sent-message-size',
      metricName: 'SentMessageSize',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'sent-message-size-anomaly',
      metricName: 'SentMessageSize',
      metricNamespace: 'AWS/SQS',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
  ],
  // Owned by Harmony
  TG: [
    {
      tagKey: '4xx-count',
      metricName: 'HTTPCode_Target_4XX_Count',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: '4xx-count-anomaly',
      metricName: 'HTTPCode_Target_4XX_Count',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: '5xx-count',
      metricName: 'HTTPCode_Target_5XX_Count',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: '5xx-count-anomaly',
      metricName: 'HTTPCode_Target_5XX_Count',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        // TODO Fix thresholds
        warningThreshold: 3,
        criticalThreshold: 6,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    // TODO under advisement from Trent, anomaly detection is not recommended for request count
    {
      tagKey: 'response-time',
      metricName: 'TargetResponseTime',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: 3,
        criticalThreshold: 5,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'response-time-anomaly',
      metricName: 'TargetResponseTime',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 5,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'unhealthy-host-count',
      metricName: 'UnHealthyHostCount',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: 1,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Maximum',
        dataPointsToAlarm: 2,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
  ],
  TransitGateway: [
    {
      tagKey: 'bytesin',
      metricName: 'BytesIn',
      metricNamespace: 'AWS/TransitGateway',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 187500000000,
        criticalThreshold: 225000000000,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'bytesin-anomaly',
      metricName: 'BytesIn',
      metricNamespace: 'AWS/TransitGateway',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'bytesout',
      metricName: 'BytesOut',
      metricNamespace: 'AWS/TransitGateway',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 187500000000,
        criticalThreshold: 225000000000,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'bytesout-anomaly',
      metricName: 'BytesOut',
      metricNamespace: 'AWS/TransitGateway',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
  ],
  VPN: [
    // TODO Add alarms and get buy off from team lead on PR
    {
      tagKey: 'tunnel-state',
      metricName: 'TunnelState',
      metricNamespace: 'AWS/VPN',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: 0,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'LessThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'tunnel-state-anomaly',
      metricName: 'TunnelState',
      metricNamespace: 'AWS/VPN',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'LessThanLowerThreshold',
        missingDataTreatment: 'ignore',
      },
    },
  ],
};
