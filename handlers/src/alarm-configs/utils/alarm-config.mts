import {
  MissingDataTreatment,
  MetricAlarmOptions,
  ValidStatistic,
} from '../../types/index.mjs';
import {safeParse} from 'valibot';
import {TreatMissingData} from 'aws-cdk-lib/aws-cloudwatch';
import {ComparisonOperator} from '@aws-sdk/client-cloudwatch';
import {validStatSchema} from './valibot-schemas.mjs';

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

export function parseStatisticOption(
  exp: string,
  defaultValue: ValidStatistic,
): ValidStatistic {
  // Base formatting normalization for validating statistics
  const trim = exp.trim().toLowerCase();

  // Normalize Value to match the various expected Valid Statistics values
  const statVariants = [
    {
      pattern: 'Standard',
      value: trim.charAt(0).toUpperCase() + trim.slice(1), // e.g., "Average" "Maximum" "Minimum" "SampleCount" "Sum"
    },
    {
      pattern: 'ExtShort',
      value: trim, // e.g., "p1", "tm22", "tc3", "ts4", "wm59", "IQM"
    },
    {
      pattern: 'ExtRange',
      value: trim.substring(0, 2).toUpperCase() + trim.substring(2), // e.g., "TM(12%:55%)", "WM(:24)", "TC(44:76)"
    },
  ];

  /** V alibot validation for the statistic value  {@link validStatSchema} */
  const match = statVariants.find(
    (p) => safeParse(validStatSchema, p.value).success,
  );

  // If a match is found, return the value, otherwise return the default value
  return match ? (match.value as ValidStatistic) : defaultValue;
}

function parseComparisonOperatorOption(
  value: string,
  defaultValue: ComparisonOperator,
): ComparisonOperator {
  // Check if a normalized value input is a valid comparison operator
  const validOperator = Object.keys(ComparisonOperator).find(
    (operator) => operator.toLowerCase() === value.trim().toLowerCase(),
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
  const validDataTreatment = Object.keys(TreatMissingData).find(
    (V) => V.toLowerCase() === value.trim().toLowerCase(),
  );

  if (validDataTreatment) {
    return TreatMissingData[
      validDataTreatment as keyof typeof TreatMissingData
    ];
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
