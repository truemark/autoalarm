import {
  MissingDataTreatment,
  MetricAlarmOptions,
  ValidStatistic,
} from '../../types/index.mjs';
import {safeParse} from 'valibot';
import {TreatMissingData} from 'aws-cdk-lib/aws-cloudwatch';
import {ComparisonOperator} from '@aws-sdk/client-cloudwatch';
import {
  rangePatternSchema,
  singleValSchema,
  standardStatSchema,
} from './valibot-schemas.mjs';
import * as logging from '@nr1e/logging';

// Initialize logging
const level = process.env.LOG_LEVEL || 'info';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'alarm-config',
  level,
});

export function metricAlarmOptionsToString(value: MetricAlarmOptions): string {
  return (
    // Nullish, NOT falsy: a threshold of 0 is legitimate (e.g. RDS
    // DatabaseDeadlocks alarms on > 0). A falsy check renders 0 as '-', which
    // parses back as null — silently disabling the alarm on a round trip.
    (value.warningThreshold ?? '-') +
    '/' +
    (value.criticalThreshold ?? '-') +
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

/**
 * A complete JSON-style number and nothing else.
 *
 * `parseFloat` is deliberately NOT used for tag values: it parses a leading
 * numeric prefix and discards the rest, so a user typo becomes a plausible but
 * wrong number instead of an error. Measured: '90abc' -> 90, '90%' -> 90,
 * '0x10' -> 0, and worst of all '1,200' -> 1 — a 1200x misconfiguration with
 * no signal that anything was wrong. `\d` is ASCII-only in JS, so
 * non-ASCII digits ('٩٠', which parseFloat accepts as 90) are rejected too.
 */
const STRICT_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parse a strictly-numeric, finite tag field.
 *
 * Returns undefined when the input is not a complete finite number, leaving
 * the caller to log and apply its own default. Non-finite is rejected as well
 * as unparseable: 'Infinity' and overflow literals like '1e400' both yield
 * Infinity, which serialises to null in the CloudWatch API call.
 */
function strictNumber(trimmed: string): number | undefined {
  if (!STRICT_NUMBER.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
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

  const parsedValue = strictNumber(trimmed);

  // Every fallback is logged. A threshold that silently becomes its default is
  // an alarm that quietly watches the wrong number.
  if (parsedValue === undefined) {
    log
      .warn()
      .str('Function', 'parseThresholdOption')
      .str('Input', value)
      .str('DefaultValue', String(defaultValue))
      .msg(
        'Value is not a complete finite number. Falling back to the default value.',
      );
    return defaultValue;
  }

  return parsedValue;
}

function parseIntegerOption(value: string, defaultValue: number): number {
  const trimmed = value.trim();
  if (trimmed === '') {
    return defaultValue;
  }

  const parsedValue = strictNumber(trimmed);

  if (parsedValue === undefined) {
    log
      .warn()
      .str('Function', 'parseIntegerOption')
      .str('Input', value)
      .num('DefaultValue', defaultValue)
      .msg(
        'Value is not a complete finite number. Falling back to the default value.',
      );
    return defaultValue;
  }

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    log
      .warn()
      .str('Function', 'parseIntegerOption')
      .str('Input', value)
      .num('DefaultValue', defaultValue)
      .msg(
        'Value is not a positive integer. Falling back to the default value.',
      );
    return defaultValue;
  }

  return parsedValue;
}

export function parseStatisticOption(
  exp: string,
  defaultValue: ValidStatistic,
): ValidStatistic {
  // Base formatting normalization for validating statistics
  let trim = exp.trim().toLowerCase();
  if (trim === 'iqm') {
    trim = 'IQM'; // Account for IQM as all caps and single word expression
  } else if (trim === 'samplecount') {
    trim = 'SampleCount'; // Account for SampleCount with CamelCase
  }

  // Early return if we match IQM or SampleCount
  if (trim === 'IQM' || trim === 'SampleCount') return trim as ValidStatistic;

  // Normalize Value to match the various expected Valid Statistics values
  const statVariants = [
    {
      schema: standardStatSchema,
      value: trim.charAt(0).toUpperCase() + trim.slice(1), // e.g., "Average" "Maximum" "Minimum" "Sum"
    },
    {
      schema: singleValSchema,
      value: trim, // e.g., "p1", "tm22", "tc3", "ts4", "wm59"
    },
    {
      schema: rangePatternSchema,
      value: trim.substring(0, 2).toUpperCase() + trim.substring(2), // e.g., "TM12:55", "WM(:24)", "TC44:76"
    },
  ];

  // Valibot validation for each variant in statVariants
  const match = statVariants.find((v) => {
    const result = safeParse(v.schema, v.value as string);
    if (!result.success) {
      log
        .warn()
        .str('Function', 'parseStatisticOption')
        .str('Input', exp)
        .str('CoercedValue', v.value)
        .obj('ValibotError', result.issues)
        .obj('ValibotResult', result.output as object)
        .msg('Valibot Validation Failed');
      return false;
    }
    return true;
  });

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
  const normalized = value.trim().toLowerCase();

  // Match against the enum VALUES first (e.g. 'notBreaching', 'ignore') which
  // are the documented tag values and what the CloudWatch API expects.
  const validDataTreatmentValue = Object.values(TreatMissingData).find(
    (treatment) => treatment.toLowerCase() === normalized,
  );

  if (validDataTreatmentValue) {
    return validDataTreatmentValue as MissingDataTreatment;
  }

  // Fall back to matching the legacy enum KEY spellings (e.g. 'NOT_BREACHING')
  // so existing tags using those values keep working. Return the mapped VALUE.
  const validDataTreatmentKey = Object.keys(TreatMissingData).find(
    (key) => key.toLowerCase() === normalized,
  );

  if (validDataTreatmentKey) {
    return TreatMissingData[
      validDataTreatmentKey as keyof typeof TreatMissingData
    ];
  }

  return defaultValue;
}

/**
 * Parse a tag value into alarm options.
 *
 * This enforces only what is true of the tag GRAMMAR — numbers must be
 * complete and finite, integers positive. CloudWatch's own limits (the valid
 * period set, the evaluation-window ceiling, dataPointsToAlarm <=
 * evaluationPeriods) are deliberately NOT applied here: the Prometheus rule
 * path in `prometheus-tools.mts` consumes these same options and uses
 * `period * evaluationPeriods` as a plain duration, where CloudWatch's period
 * rules do not apply. Those constraints live on the CloudWatch path, in
 * `alarm-tools.mts`.
 */
export function parseMetricAlarmOptions(
  value: string,
  defaults: MetricAlarmOptions,
): MetricAlarmOptions {
  const parts = value.split('/');
  const parsed = {
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

  return parsed;
}
