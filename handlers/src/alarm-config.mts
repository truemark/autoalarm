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

  // TODO Stop prefixing alb- and ec2- and os-. It's redundant. The resource that's tag dictates the set to use.

  // Owned by Harmony
  ALB: [
    // TODO Add remaining alarms and get buy off from team lead on PR
    {
      tagKey: 'alb-4xx-count',
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
      tagKey: 'alb-4xx-count-anomaly',
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
      tagKey: 'alb-5xx-count',
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
      tagKey: 'alb-5xx-count-anomaly',
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
      tagKey: 'alb-request-count',
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
      tagKey: 'alb-request-count-anomaly',
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
  // Owned by Harmony
  EC2: [
    // TODO Add alarms and get buy off from team lead on PR
    {
      // TODO I think this static alarm should be enabled by default with a warning of 95 and critical of 98 for 2 periods of 300 seconds, discuss with Trent and get what he wants
      tagKey: 'ec2-cpu',
      metricName: 'CPUUtilization',
      metricNamespace: 'AWS/EC2',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 95,
        criticalThreshold: 98,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'ec2-cpu-anomaly',
      metricName: 'CPUUtilization',
      metricNamespace: 'AWS/EC2',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 3,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    // TODO I think this static alarm should be enabled by default with a warning of 95 and critical of 98 for 2 periods of 300 seconds, discuss with Trent and get what he wants
    {
      tagKey: 'ec2-memory',
      metricName: '', // Empty string to account for divergent metric names between windows and linux instances for EC2 storage and memory configs. Assigned programmatically in ec2-modules.
      metricNamespace: 'CWAgent',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 90,
        criticalThreshold: 95,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    // TODO I would have this off by default, discuss with Trent and get what he wants
    {
      tagKey: 'ec2-memory-anomaly',
      metricName: '', // Empty string to account for divergent metric names between windows and linux instances for EC2 storage and memory configs. Assigned programmatically in ec2-modules.
      metricNamespace: 'CWAgent',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        // TODO Not using good anomaly defaults
        warningThreshold: 2,
        criticalThreshold: 3,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    // TODO Discuss with Trent, not sure if there is a way to do percentages, that would be nice. Anomaly may be our best bet. Although we need something static set to know when we have very little left.
    {
      tagKey: 'ec2-storage',
      metricName: '', // Empty string to account for divergent metric names between windows and linux instances for EC2 storage and memory configs. Assigned programmatically in ec2-modules.
      metricNamespace: 'CWAgent',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: 90,
        criticalThreshold: 95,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'ec2-storage-anomaly',
      metricName: '', // Empty string to account for divergent metric names between windows and linux instances for EC2 storage and memory configs. Assigned programmatically in ec2-modules.
      metricNamespace: 'CWAgent',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: 2,
        criticalThreshold: 3,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
  ],
  // Owned by Harmony
  // TODO Once these are settled, please get an issue recorded in the overwatch repo to enable AutoAlarm tags for OpenSearch for Trent / Fouad to implement.
  OpenSearch: [
    {
      tagKey: 'os-4xx-errors',
      metricName: '4xx',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: 100, // TODO makes no sense to me, I would make null
        criticalThreshold: 300, // TODO makes no sense to me, I would make null
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
      tagKey: 'os-4xx-errors-anomaly',
      metricName: '4xx',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-5xx-errors',
      metricName: '5xx',
      metricNamespace: 'AWS/ES',
      defaultCreate: false, // TODO I think I would enable this by default
      anomaly: false,
      defaults: {
        warningThreshold: 100, // TODO This threshold make no sense to me
        criticalThreshold: 300, // TODO This threshold make no sense to me
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO I think I would use a static threshold and not an anomaly by default. Discuss with Trent and get his decision.
      tagKey: 'os-5xx-errors-anomaly',
      metricName: '5xx',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-cpu',
      metricName: 'CPUUtilization',
      metricNamespace: 'AWS/ES',
      defaultCreate: false, // TODO I think we should enable this by default and have anomaly off by default. Get with Trent and decide.
      anomaly: false,
      defaults: {
        // TODO Discuss with Trent, these seem to low to me for defaults
        warningThreshold: 85,
        criticalThreshold: 90,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-cpu-anomaly',
      metricName: 'CPUUtilization',
      metricNamespace: 'AWS/ES',
      defaultCreate: true, // TODO I would not have this enabled by default. Discuss with Trent and get his decision.
      anomaly: true,
      defaults: {
        // TODO Thresholds should be fixed
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO I think this could be set by default with good values and I would not use anomaly by default.
      tagKey: 'os-iops-throttle',
      metricName: 'IopsThrottle',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: 10, // TODO This makes no sense as a default
        criticalThreshold: 20, // TODO This makes no sense as a default
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-iops-throttle-anomaly',
      metricName: 'IopsThrottle',
      metricNamespace: 'AWS/ES',
      defaultCreate: true, // TODO I think a static threshold alarm will suffice and work well if set properly.
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-jvm-memory',
      metricName: 'JVMMemoryPressure',
      metricNamespace: 'AWS/ES',
      defaultCreate: false, // TODO I think this should be enabled by default.
      anomaly: false,
      defaults: {
        // TODO Discuss with Trent, these seem to low to me for defaults
        warningThreshold: 85,
        criticalThreshold: 90,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-jvm-memory-anomaly',
      metricName: 'JVMMemoryPressure',
      metricNamespace: 'AWS/ES',
      defaultCreate: true, // TODO I would not use anomaly by default. Discuss with Trent and get his decision.
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO I would have this enabled by default with high reasonable defaults
      tagKey: 'os-read-latency',
      metricName: 'ReadLatency',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: 500, // TODO This value makes no sense to me.
        criticalThreshold: 1000, // TODO This value makes no sense to me.
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-read-latency-anomaly',
      metricName: 'ReadLatency',
      metricNamespace: 'AWS/ES',
      defaultCreate: true, // TODO I would not have this enabled by default
      anomaly: true,
      defaults: {
        // TODO These aren't good defaults
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    // TODO Discuss with Trent, not sure what's best here. Sort of depends on usage which is hard to set statically.
    {
      tagKey: 'os-search-latency',
      metricName: 'SearchLatency',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: 3000,
        criticalThreshold: 5000,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-search-latency-anomaly',
      metricName: 'SearchLatency',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO I think this should be enabled by default. Discuss with Trent and get his decision.
      tagKey: 'os-snapshot-failure',
      metricName: 'AutomatedSnapshotFailure',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: 1,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-snapshot-failure-anomaly',
      metricName: 'AutomatedSnapshotFailure',
      metricNamespace: 'AWS/ES',
      defaultCreate: true, // TODO This should not be enabled by default
      anomaly: true,
      defaults: {
        // TODO Bad thresholds
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO I think the static alarm should be enabled by default
      tagKey: 'os-storage',
      metricName: 'FreeStorageSpace',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        // TODO I would set these higher. Also, are we sure these are percentages? Discuss with Trent and look at data on existing instances.
        warningThreshold: 85,
        criticalThreshold: 90,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-storage-anomaly',
      metricName: 'FreeStorageSpace',
      metricNamespace: 'AWS/ES',
      defaultCreate: true, // TODO I would not enable this by default, discuss with Trent.
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO I think this should be enabled by default. Discuss with Trent and get his decision.
      tagKey: 'os-sys-memory-util',
      metricName: 'SysMemoryUtilization',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        // TODO I would set these higher. Also, are we sure these are percentages? Discuss with Trent and look at data on existing instances.
        warningThreshold: 85,
        criticalThreshold: 90,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-sys-memory-util-anomaly',
      metricName: 'SysMemoryUtilization',
      metricNamespace: 'AWS/ES',
      defaultCreate: true, // TODO I would not enable by default
      anomaly: true,
      defaults: {
        // TODO Set responsible thresholds. These aren't great.
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO I would have these enabled by default with good static thresholds. Discuss with Trent and get his decision.
      tagKey: 'os-throughput-throttle',
      metricName: 'ThroughputThrottle',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: 10,
        criticalThreshold: 20,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-throughput-throttle-anomaly',
      metricName: 'ThroughputThrottle',
      metricNamespace: 'AWS/ES',
      defaultCreate: true, // TODO I would not enable by default
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO I think this should be enabled by default. Discuss with Trent and get his decision.
      tagKey: 'os-write-latency',
      metricName: 'WriteLatency',
      metricNamespace: 'AWS/ES',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: 500,
        criticalThreshold: 1000,
        period: 300,
        evaluationPeriods: 2,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-write-latency-anomaly',
      metricName: 'WriteLatency',
      metricNamespace: 'AWS/ES',
      defaultCreate: true, // TODO I would not enable by default
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO I think this should be enabled by default. Discuss with Trent and get his decision. I also think this should be a critical only alarm by default.
      tagKey: 'os-yellow-cluster',
      metricName: 'ClusterStatus.yellow',
      metricNamespace: 'AWS/ES',
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
      // TODO I wouldn't even support an anomaly on this. It makes no sense. I would delete this.
      tagKey: 'os-yellow-cluster-anomaly',
      metricName: 'ClusterStatus.yellow',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'os-red-cluster',
      metricName: 'ClusterStatus.red',
      metricNamespace: 'AWS/ES',
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
      tagKey: 'os-red-cluster-anomaly',
      metricName: 'ClusterStatus.red',
      metricNamespace: 'AWS/ES',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
  ],

  // Owned by Harmony
  OpenSearchServerless: [
    // TODO Add alarms and get buy off from team lead on PR
  ],
  // Owned by DB Warden
  RDS: [
    // TODO Add alarms and get buy off from team lead on PR
  ],
  // Owned by Harmony
  SNS: [
    // TODO Add alarms and get buy off from team lead on PR
  ],
  // Owned by Harmony
  SQS: [
    {
      tagKey: 'sqs-age-of-oldest-message',
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
      tagKey: 'sqs-age-of-oldest-message-anomaly',
      metricName: 'ApproximateAgeOfOldestMessage',
      metricNamespace: 'AWS/SQS',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'sqs-empty-recieves',
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
      tagKey: 'sqs-empty-recieves-anomaly',
      metricName: 'NumberOfEmptyReceive',
      metricNamespace: 'AWS/SQS',
      defaultCreate: true, // TODO I do not think this should be enabled by default. I also wouldn't enable the static alarm by default either.
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
      tagKey: 'sqs-messages-deleted',
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
      tagKey: 'sqs-messages-deleted-anomaly',
      metricName: 'NumberOfMessagesDeleted',
      metricNamespace: 'AWS/SQS',
      defaultCreate: true, // TODO I do not think this should be enabled by default. I also wouldn't enable the static alarm by default either.
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
      tagKey: 'sqs-messages-not-visible',
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
      tagKey: 'sqs-messages-not-visible-anomaly',
      metricName: 'ApproximateNumberOfMessagesNotVisible',
      metricNamespace: 'AWS/SQS',
      defaultCreate: true, // TODO I do not think this should be enabled by default. I also wouldn't enable the static alarm by default either.
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'sqs-messages-received',
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
      tagKey: 'sqs-messages-received-anomaly',
      metricName: 'NumberOfMessagesReceived',
      metricNamespace: 'AWS/SQS',
      defaultCreate: true, // TODO I do not think this should be enabled by default. I also wouldn't enable the static alarm by default either.
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
      tagKey: 'sqs-messages-sent',
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
      tagKey: 'sqs-messages-sent-anomaly',
      metricName: 'NumberOfMessagesSent',
      metricNamespace: 'AWS/SQS',
      defaultCreate: true, // TODO I do not think this should be enabled by default. I also wouldn't enable the static alarm by default either.
      anomaly: true,
      defaults: {
        warningThreshold: 1,
        criticalThreshold: 1,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'sqs-messages-visible',
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
      tagKey: 'sqs-messages-visible-anomaly',
      metricName: 'ApproximateNumberOfMessagesVisible',
      metricNamespace: 'AWS/SQS',
      defaultCreate: true, // TODO I do not think this should be enabled by default. I also wouldn't enable the static alarm by default either.
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'sqs-number-of-messages-delayed',
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
      tagKey: 'sqs-number-of-messages-delayed-anomaly',
      metricName: 'ApproximateNumberOfMessagesDelayed',
      metricNamespace: 'AWS/SQS',
      defaultCreate: true, // TODO I do not think this should be enabled by default. I also wouldn't enable the static alarm by default either.
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 300,
        evaluationPeriods: 1,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'sqs-sent-message-size',
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
      tagKey: 'sqs-sent-message-size-anomaly',
      metricName: 'SentMessageSize',
      metricNamespace: 'AWS/SQS',
      defaultCreate: true, // TODO I do not think this should be enabled by default. I also wouldn't enable the static alarm by default either.
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
      tagKey: 'tg-4xx-count',
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
      tagKey: 'tg-4xx-count-anomaly',
      metricName: 'HTTPCode_Target_4XX_Count',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: true, // TODO Discuss with Trent, I don't think I would enable this by default
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'tg-5xx-count',
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
      tagKey: 'tg-5xx-count-anomaly',
      metricName: 'HTTPCode_Target_5XX_Count',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        // TODO Fix thresholds
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'tg-request-count',
      metricName: 'RequestCountPerTarget',
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
      tagKey: 'tg-request-count-anomaly',
      metricName: 'RequestCountPerTarget',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: true, // TODO I do not think this should be enabled by default. I also wouldn't enable the static alarm by default either.
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'tg-response-time',
      metricName: 'TargetResponseTime',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: false,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'tg-response-time-anomaly',
      metricName: 'TargetResponseTime',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        // TODO Set more reasonable defaults. Discuss with Trent.
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'tg-unhealthy-host-count',
      metricName: 'UnHealthyHostCount',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: false, // TODO I think this should be enabled by default.
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: 1,
        period: 60,
        evaluationPeriods: 3,
        statistic: 'Maximum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      // TODO Not even sure it makes sense to have an anomaly option on this. Discuss with Trent.
      tagKey: 'tg-unhealthy-host-count-anomaly',
      metricName: 'UnHealthyHostCount',
      metricNamespace: 'AWS/ApplicationELB',
      defaultCreate: true,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: 1,
        period: 60,
        evaluationPeriods: 2,
        statistic: 'p90',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
  ],
};
