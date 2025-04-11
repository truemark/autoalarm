import {
  MissingDataTreatment,
  MetricAlarmOptions,
  MetricAlarmConfigs,
  ValidStatistic,
  ValidExtendedStat,
  ValidExtendedStatKey,
  ValidStandardStat,
  StandardStatKey,
} from '#types/alarm-config-types.mjs';
import {StatFactory} from '#stats-factory/stat-factory.mjs';
import {ComparisonOperator} from '@aws-sdk/client-cloudwatch';

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

//function parseStatisticOption2(
//  value: ValidStatistic,
//  defaultValue: ValidStatistic,
//): string {
//  const regexp = /^p.*|^tm.*|^tc.*|^ts.*|^wm.*|^iqm$/;
//  const statistics = ['SampleCount', 'Average', 'Sum', 'Minimum', 'Maximum'];
//  const statisticsRecord: Record<string, string> = {};
//  for (const statistic of statistics) {
//    statisticsRecord[statistic.toLowerCase()] = statistic;
//  }
//  const trimmed: string = value.trim().toLowerCase();
//
//  if (trimmed === '') {
//    return defaultValue;
//  }
//  if (statisticsRecord[trimmed]) {
//    return statisticsRecord[trimmed];
//  }
//  if (trimmed.match(regexp)) {
//    return trimmed;
//  }
//  return defaultValue;
//}

/**
 * Helper unction to parse an  Extended statistic option from a string value.
 * Used in {@link parseStatisticOption}
 * @note statExpression is passed in trimmed and toLowerCase from parseStatisticOption
 * @param  - The string value representing the statistic.
 * @returns A ValidExtendedStat via StatFactory.Extended build methods or undefined.
 */
function extendedStatsBuilder(
  statExpression: string,
): ValidExtendedStat | undefined {
  /**Quick Check to see if the passed value is IQM as this has no parameters and is an easy return*/
  if (statExpression === 'iqm') {
    return StatFactory.Extended.iqm; //Build typesafe IQM statistic
  }

  /**
   * Quickly grab Extended Stat prefix which should match with a valid StatFactory method see {@link StatFactory.Extended}
   * Check for p: percentile stat as this is the only single letter prefix - Everything else is two letters.
   */
  const statPrefix =
    statExpression[0] === 'p'
      ? statExpression[0]
      : statExpression.substring(0, 2);

  /**
   * Early validation that statPrefix === keyof StatFactory.Extended
   * If we can't match a key in StatFactory.Extended, early return undefined
   */
  if (
    !Object.keys(StatFactory.Extended).some(
      (key) => key.toLowerCase() === statPrefix,
    )
  ) {
    return undefined;
  }

  /**
   * Extract parameters from string for StatFactory.Extended methods used later to build a ValidExtendedStat
   *  - Split off prefix (eg "p90" to "90", tm(90:100) to "90:100")
   *  - Remove parentheses and percent signs to get raw number values if they exist.
   *  - Split the parameters by ':' or ',', and validate valid integer values in the string array
   */
  const params = statExpression
    .substring(statPrefix.length)
    .replace(/[()%]/g, '') // Remove parenthesis and percent signs
    .split(/[,:]+/) // Split the parameters by ':' or ','
    .map((s) => Number(s)); // validate valid integer values in the string array. If not, values are isNaN

  // Validate that params is not empty no more than two values and does not contain isNaN values. If so return undefined
  if (params.length === 0 || params.length > 2 || params.some(isNaN)) {
    return undefined;
  }

  // At this point, we have a valid prefix and integer parameters. Try to build the extended statistic
  try {
    // Use StatFactory to build and return a typesafe Extended Statistic
    // Let StatFactory handle the validation of the parameters and errors
    return StatFactory.Extended[statPrefix as ValidExtendedStatKey](...params);
  } catch (error) {
    // If an error occurs during building, return undefined
    return undefined;
  }
}

/**
 * Helper function to build a standard statistic from a string expression
 * Used in {@link parseStatisticOption}
 * @note statExpression is passed in trimmed and toLowerCase from parseStatisticOption
 * @param statExpression
 * @returns ValidStandardStat via StatFactory.Standard build methods or  undefined
 */
function standardStatsBuilder(
  statExpression: string,
): ValidStandardStat | undefined {
  // Locate the standard statistic key in the StatFactory.Standard object if it exists
  const standardStatKey = Object.keys(StatFactory.Standard).find(
    (K) => K.toLowerCase() === statExpression,
  );

  // Use StatFactory to build and return a typesafe Standard Statistic
  if (standardStatKey) {
    return StatFactory.Standard[standardStatKey as StandardStatKey];
  }

  // If the standard statistic key is not found, return undefined
  return undefined;
}

/**
 * Main Statistic parsing function that handles both standard and extended statistics.
 *  - First checks if the value is a standard statistic:
 *  - If so, it builds a ValidStandardStat using the standardStatsBuilder function via StatFactory.Standard methods
 *  - If not, it tries to build a ValidExtendedStat {@link ValidExtendedStat} using the extendedStatsBuilder function via
 *    StatFactory.Extended methods
 *  - If neither works, it returns the default value.
 * @param  - The string value representing the statistic.
 * @param defaultValue - The default value to return if parsing fails.
 * @returns A ValidStatistic object representing the parsed statistic.
 */
function parseStatisticOption(
  value: string,
  defaultValue: ValidStatistic,
): ValidStatistic {
  // Normalize the input value
  const trimmed = value.trim().toLowerCase();

  // Check if it's a standard stat first
  if (
    Object.keys(StatFactory.Standard).some((k) => k.toLowerCase() === trimmed)
  ) {
    const standardStat = standardStatsBuilder(trimmed);
    if (standardStat) {
      return standardStat; //return a typesafe Standard Statistic from StatFactory.Standard key values
    }
  }

  // If not a valid standard stat, try extended stat
  const extendedStat = extendedStatsBuilder(trimmed);
  if (extendedStat) {
    return extendedStat; //return a typesafe Extended Statistic from StatFactory.Extended methods
  }

  // If neither worked, return the default value
  return defaultValue;
}

function parseComparisonOperatorOption(
  value: string,
  defaultValue: ComparisonOperator,
): ComparisonOperator {
  // Normalize the input value
  const trimmed: string = value.trim().toLowerCase();

  // Check if it's a valid comparison operator
  const validOperator = Object.keys(ComparisonOperator).find(
    (operator) => operator.toLowerCase() === trimmed,
  );

  // If it's a valid operator, return it
  if (validOperator) {
    return validOperator as ComparisonOperator;
  }

  // If not a valid comparison operator, return the default value
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
        ? (parseStatisticOption(
            parts[4],
            defaults.statistic,
          ) satisfies ValidStatistic)
        : (defaults.statistic satisfies ValidStatistic),
    dataPointsToAlarm:
      parts.length > 5
        ? parseIntegerOption(parts[5], defaults.dataPointsToAlarm)
        : defaults.dataPointsToAlarm,
    comparisonOperator:
      parts.length > 6
        ? (parseComparisonOperatorOption(
            parts[6],
            defaults.comparisonOperator,
          ) satisfies ComparisonOperator)
        : (defaults.comparisonOperator satisfies ComparisonOperator),
    missingDataTreatment:
      parts.length > 7
        ? (parseMissingDataTreatmentOption(
            parts[7],
            defaults.missingDataTreatment,
          ) satisfies MissingDataTreatment)
        : (defaults.missingDataTreatment satisfies MissingDataTreatment),
  };
}

// You are expected to collaborate and get approval from the team lead for each team that owns the service
// to determine the appropriate alarm configurations. Do not make assumptions and ensure any alarm configurations
// are approved by the team lead. At the end of the day, the team lead is responsible for the service and the alarms.
export const AlarmConfigs: MetricAlarmConfigs = {
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
        statistic: 'p89',
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
        //TODO: Confirm with DevOps to fix typo
        statistic: 'tm',
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
        statistic: 'Sum',
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
        statistic: 'Sum',
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
        warningThreshold: 5,
        criticalThreshold: 9,
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
        warningThreshold: 5,
        criticalThreshold: 9,
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
  StepFunctions: [
    {
      tagKey: 'executions-failed',
      metricName: 'ExecutionsFailed',
      metricNamespace: 'AWS/States',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: 1,
        period: 60,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'executions-failed-anomaly',
      metricName: 'ExecutionsFailed',
      metricNamespace: 'AWS/States',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
        evaluationPeriods: 1,
        statistic: 'Average',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanUpperThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'executions-timed-out',
      metricName: 'ExecutionsTimedOut',
      metricNamespace: 'AWS/States',
      defaultCreate: true,
      anomaly: false,
      defaults: {
        warningThreshold: null,
        criticalThreshold: 1,
        period: 60,
        evaluationPeriods: 1,
        statistic: 'Sum',
        dataPointsToAlarm: 1,
        comparisonOperator: 'GreaterThanThreshold',
        missingDataTreatment: 'ignore',
      },
    },
    {
      tagKey: 'executions-timed-out-anomaly',
      metricName: 'ExecutionsTimedOut',
      metricNamespace: 'AWS/States',
      defaultCreate: false,
      anomaly: true,
      defaults: {
        warningThreshold: null,
        criticalThreshold: null,
        period: 60,
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
