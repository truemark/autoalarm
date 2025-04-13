import {
  MissingDataTreatment,
  MetricAlarmOptions,
  ValidStatistic,
  ValidExtendedStat,
  ValidStandardStat,
} from '#types/alarm-config-types.mjs';
import * as v from 'valibot';
import {TreatMissingData} from 'aws-cdk-lib/aws-cloudwatch';
import {ComparisonOperator, Statistic} from '@aws-sdk/client-cloudwatch';
import {
  rangePatternSchema,
  singleValSchema,
} from '#cloudwatch-alarm-utils/valibot-schemas.mjs';

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
  value: string,
  defaultValue: ValidStatistic,
): ValidStatistic {
  // Normalize the value to lowercase and trim whitespace
  const trimmed = value.trim().toLowerCase();

  // Easy check for IQM which has no following parameters
  if (trimmed === 'iqm') {
    return 'IQM' as ValidExtendedStat;
  }

  // Filter for Standard Statistic using AWS' Statistic enum
  const standardStat = Object.values(Statistic).filter(
    (value) => value.toLowerCase() === trimmed,
  );

  // Return valid standard statistic if found
  if (standardStat.length > 0) {
    return standardStat[0] as ValidStandardStat;
  }

  /**
   * Here we want to be thoughtful about creating a resilient validation flow to try and normalize the value
   * if we can to match a valid extended statistic. There are lowercase and upper case variants with absolute values
   * and percentage values. We can perform simple prefix checks and vlaue checks to catch issues that might cause the
   * validation step to fail.
   * @see {@link https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-cloudwatch/Interface/PutMetricAlarmCommandInput/}
   * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html}
   */

  /**
   * Use trimmed value to catch any case issues with letter casing and then use valibot to check for simple percentile stats
   * such as (p10, tm10, tc10, ts25, wm76 etc.) via the {@link singleValSchema}.
   */
  if (v.safeParse(singleValSchema, trimmed).success) {
    return trimmed as ValidExtendedStat;
  }

  /**
   * If singleValSchema fails we know it isn't a simple percentile. We know that these types of stats start with two
   * capital chars so let's take our value and coerce the first two chars to uppercase just to ensure we give the
   * value the best shot of matching a valid extended statistic.
   */
  const coercedValue =
    trimmed.substring(0, 2).toUpperCase() + trimmed.substring(2);

  /**
   * Now we can use valibot to check for the extended statistics via the {@link rangePatternSchema}.
   */
  //if (v.safeParse(rangePatternSchema, coercedValue).success) {
  //  return coercedValue as ValidExtendedStat;
  //}

  const validation = v.safeParse(rangePatternSchema, coercedValue);
  if (validation) {
    if (validation.success) {
      console.log('Input value:', value);
      console.log('Coerced value:', coercedValue);
      console.log(validation.output);
      console.log(
        'Range content:',
        coercedValue.substring(
          coercedValue.indexOf('(') + 1,
          coercedValue.lastIndexOf(')'),
        ),
      );
      return coercedValue as ValidExtendedStat;
    } else {
      console.error('Validation failed:', validation.issues);
      console.log('Input value:', value);
      console.log('Coerced value:', coercedValue);
      console.log(validation.output);
      console.log(
        'Range content:',
        coercedValue.substring(
          coercedValue.indexOf('(') + 1,
          coercedValue.lastIndexOf(')'),
        ),
      );
    }
  }

  // If we reach here, it means the value is sadly not a valid statistic... Fallback to default value
  return defaultValue as ValidStatistic;
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
