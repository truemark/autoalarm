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
  try {
    return parseFloat(trimmed);
  } catch (err) {
    return defaultValue;
  }
}

function parseIntegerOption(value: string, defaultValue: number): number {
  const trimmed = value.trim();
  if (trimmed === '') {
    return defaultValue;
  }
  try {
    return parseInt(trimmed);
  } catch (err) {
    return defaultValue;
  }
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

  // Owned by Harmony
  ALB: [
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
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
      // TODO Add remaining alarms and get buy off from team lead on PR
    },
  ],
  // Owned by Harmony
  EC2: [
    // TODO Add alarms and get buy off from team lead on PR
  ],
  // Owned by Harmony
  ECS: [
    // TODO Add alarms and get buy off from team lead on PR
  ],
  // Owned by Harmony
  Lambda: [
    // TODO Add alarms and get buy off from team lead on PR
  ],
  // Owned by Harmony
  NLB: [
    // TODO Add alarms and get buy off from team lead on PR
  ],
  // Owned by Harmony
  OpenSearch: [
    // TODO Add alarms and get buy off from team lead on PR
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
    // TODO Add alarms and get buy off from team lead on PR
  ],
  // Owned by Harmony
  TG: [
    // TODO Add alarms and get buy off from team lead on PR
  ],
};
