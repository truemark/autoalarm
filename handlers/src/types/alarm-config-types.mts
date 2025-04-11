import {TreatMissingData} from 'aws-cdk-lib/aws-cloudwatch';
import {
  ComparisonOperator,
  MetricAlarm,
  Statistic,
} from '@aws-sdk/client-cloudwatch';
import {StatFactory} from "#stats-factory/stat-factory.mjs";

//=============================================================================
// Statistic Typing
//=============================================================================

/**
 * Type representing valid percentile statistics string literals.
 */
type PercentileStat = `p${number}`;

/**
 * Type representing valid percentile rank statistics string literals.
 */
type PercentileRankStat =
  | `PR(${number}:${number})`
  | `PR(:${number})`
  | `PR(${number}:)`;

/**
 * Type representing valid trimmed mean statistics string literals.
 */
type TrimmedMeanStat =
  | `tm${number}`
  | `TM(${number}%:${number}%)`
  | `TM(:${number}%)`
  | `TM(${number}%:)`
  | `TM(${number}:${number})`
  | `TM(:${number})`
  | `TM(${number}:)`;

/**
 * Type representing valid winsorized mean statistics string literals.
 */
type WinsorizedMeanStat =
  | `wm${number}`
  | `WM(${number}%:${number}%)`
  | `WM(:${number}%)`
  | `WM(${number}%:)`
  | `WM(${number}:${number})`
  | `WM(:${number})`
  | `WM(${number}:)`;

/**
 * Type representing valid trimmed count statistics string literals.
 */
type TrimmedCountStat =
  | `tc${number}`
  | `TC(${number}%:${number}%)`
  | `TC(:${number}%)`
  | `TC(${number}%:)`
  | `TC(${number}:${number})`
  | `TC(:${number})`
  | `TC(${number}:)`;

/**
 * Type representing valid trimmed sum statistics string literals.
 */
type TrimmedSumStat =
  | `ts${number}`
  | `TS(${number}%:${number}%)`
  | `TS(:${number}%)`
  | `TS(${number}%:)`
  | `TS(${number}:${number})`
  | `TS(:${number})`
  | `TS(${number}:)`;

/**
 * Type representing valid interquartile mean statistics string literals.
 */
type IQMStat = 'IQM';

/**
 * Type representing valid extended statistics string literals.
 */
export type ValidExtendedStatKey = keyof typeof StatFactory.Extended

/**
 * Type representing valid standard statistics string literals.
 */
export type StandardStatKey = keyof typeof StatFactory.Standard


/**
 * Represents valid string-format patterns for AWS CloudWatch Extended Statistics.
 *
 * Ensures type-safety when specifying CloudWatch's extended statistic identifiers.
 * Includes formatting patterns derived directly from {@link StatFactory.Extended}.
 *
 * Includes the following extended statistic patterns:
 *
 * - Interquartile Mean (`IQM`): Mean of the middle 50% of data points.
 * - Percentiles (`p90`): Simple percentile-based statistics.
 * - Trimmed Mean (`tm90`, `TM(10%:90%)`): Statistical average computed by trimming outlier data points beyond specified percentile bounds.
 * - Winsorized Mean (`wm90`, `WM(10%:90%)`): Modified average where data outside of bounds are clamped, not discarded.
 * - Trimmed Count (`tc90`, `TC(10%:90%)`): Count of data points remaining after trimming percentile ranges.
 * - Trimmed Sum (`ts90`, `TS(10%:90%)`): Sum of values within boarders after data trimming.
 * - Percentile Rank (`PR(100:2000)`): Percentage of total data points falling between specified absolute numeric bounds.
 *
 * @example
 *
 * ```typescript
 * const validPercentile: ValidExtendedStat = 'p90';        // valid
 * const validTrimMean: ValidExtendedStat = 'tm95';         // valid
 * const validTrimMeanRange: ValidExtendedStat = 'TM(5%:95%)'; // valid
 * const validPercentileRank: ValidExtendedStat = 'PR(0:300)';  // valid
 * const invalidStat: ValidExtendedStat = 'unknownStat';    // Error: invalid statistic pattern
 * ```
 *
 * @remarks
 *
 * This type encourages correct usage by limiting valid statistics strings.
 * For statically typed pattern suggestions and validation, rely on IDE autocomplete.
 *
 * @see {@link StatFactory} - Reference object for generating CloudWatch statistic strings.
 * @see {@link Stats} - Base utility class for generating AWS-compatible statistical formats.
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html}
 */
export type ValidExtendedStat =
  | IQMStat
  | PercentileStat
  | PercentileRankStat
  | TrimmedMeanStat
  | WinsorizedMeanStat
  | TrimmedCountStat
  | TrimmedSumStat;

/**
 * Type representing valid standard CloudWatch statistics string literals.
 *
 * @example
 * // Valid standard statistics:
 * // "SampleCount" | "Average" | "Sum" | "Minimum" | "Maximum"
 *
 * const stat: StandardStat = "Average"; // Valid
 * const invalidStat: StandardStat = "p(90)"; // Type error - extended statistic
 *
 * @see {@link Statistic} AWS type for standard statistics
 * @see {@link StatFactory.Standard} Object containing the standard statistic constants
 *
 */
export type ValidStandardStat = Statistic; // "SampleCount" | "Average" | "Sum" | "Minimum" | "Maximum"

/**
 * Represents all valid AWS CloudWatch statistics that can be used when interacting with AWS CloudWatch APIs.
 *
 * **1. Standard Statistics (predefined by CloudWatch API):**
 * - `"SampleCount"` - Total number of data points used in the statistical calculation.
 * - `"Average"` - is the value of Sum/SampleCount during the specified period.
 * - `"Sum"` - Total sum of the data points within the specified period.
 * - `"Minimum"` - Lowest data point observed within the specified period.
 * - `"Maximum"` - Highest data point observed within the specified period.
 *
 * **2. Extended Statistics (constructed via provided methods and types):**
 *
 * - **Percentiles (`pXX`)**
 *   Simple percentile metrics indicating relative standing in the dataset.
 *   - Example: `"p90"` (90th percentile, 90% of data points are lower)
 *
 * - **IQM**
 *   - Interquartile Mean: trimmed mean calculated from the middle 50% of observed data points; equivalent to `TM(25%:75%)`.
 *
 * - **Trimmed Mean (`tm` and `TM`)**
 *   Mean of data points within defined percent-based or numeric boundaries.
 *   - Percent shorthand: `"tm90"` (mean excluding the top 10%)
 *   - Percent explicit bounds: `"TM(10%:90%)"` (mean excluding bottom 10% and top 10%)
 *   - Numeric explicit bounds: `"TM(150:1000)"` (mean excluding all points ≤150 and >1000)
 *
 * - **Winsorized Mean (`wm` and `WM`)**
 *   Similar to Trimmed Mean, with boundary points clamped (rather than discarded).
 *   - Percent shorthand: `"wm95"` (clamps upper 5% of data points to the 95th percentile value)
 *   - Percent explicit bounds: `"WM(10%:90%)"` (clamps lower/top 10% to boundary values)
 *   - Numeric explicit bounds: `"WM(100:500)"` (clamps values outside 100–500 to boundary values)
 *
 * - **Trimmed Count (`tc` and `TC`)**
 *   The number of data points surviving trimming boundaries.
 *   - Percent shorthand: `"tc90"`
 *   - Percent explicit: `"TC(5%:95%)"`
 *   - Numeric explicit: `"TC(150:500)"`
 *
 * - **Trimmed Sum (`ts` and `TS`)**
 *   The sum of data points surviving trimming boundaries. Equals Trimmed Mean times Trimmed Count.
 *   - Percent shorthand: `"ts90"`
 *   - Percent explicit: `"TS(5%:95%)"`
 *   - Numeric explicit: `"TS(150:500)"`
 *
 * - **Percentile Rank (`PR`)**
 *   The percentage of data points that fall within defined numeric bounds.
 *   - `"PR(:300)"` (percent points ≤ 300)
 *   - `"PR(100:2000)"` (percent between 100 exclusive and 2000 inclusive)
 *   - `"PR(150:)"` (percent points > 150)
 *
 * ---
 *
 * **Usage:**
 *
 * Generate standard statistics directly from `StatFactory.Standard`:
 * ```typescript
 * const avgStat = Stats.AVERAGE;     // "Average"
 * const maxStat = Stats.MAXIMUM;     // "Maximum"
 * ```
 *
 * Generate extended statistics using provided helper methods in `StatFactory.Extended`:
 * ```typescript
 * const p90 = Stats.p(90);                          // "p90"
 * const trimmedMean = Stats.tm(10, 90);             // "TM(10%:90%)"
 * const winsorizedMean = Stats.wm(95);              // "wm95"
 * const percentileRank = Stats.pr(100, 2000);       // "PR(100:2000)"
 * ```
 *
 * ---
 *
 * **Important**:
 * When calling AWS CloudWatch APIs (such as `PutMetricAlarm`) and specifying a `MetricName`,
 * you must specify either a standard `Statistic` (such as `"Average"`) or an `ExtendedStatistic`
 * (such as `"p90"` or `"TM(5%:95%)"`), **but never both**.
 *
 * ---
 *
 * @see {@link StatFactory} Object containing methods to generate statistic strings
 * @see {@link ValidStandardStat} Type for standard statistics
 * @see {@link ValidExtendedStat} Type for extended statistics
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html} AWS
 * definitions and documentation for statistics
 */
export type ValidStatistic = ValidStandardStat | ValidExtendedStat;

//=============================================================================
// Missing Data Treatment Typing
//=============================================================================

/**
 * Specifies how CloudWatch handles missing data points when evaluating an alarm.
 * Union between `TreatMissingData` enum and `MetricAlarm` interface property. To ensure
 * That the value is strongly typed and is never undefined while type matching for
 * `PutMetricAlarmsCommand` from AWS SDK Cloudwatch Client.
 *
 * ---
 *
 * The following values determine how missing data affects alarm state:
 *
 * - `'missing'`: The alarm state doesn't change when data is missing.
 *   Missing data points are not considered in the alarm evaluation.
 *
 * - `'ignore'`: The alarm evaluates the metric based only on the data points that are present.
 *   Missing data points are effectively ignored in the evaluation.
 *
 * - `'breaching'`: Missing data points are treated as exceeding the threshold.
 *   This makes the alarm more sensitive, treating missing data as bad.
 *
 * - `'notBreaching'`: Missing data points are treated as being within the threshold.
 *   This makes the alarm less sensitive, treating missing data as good.
 *
 * ---
 *
 * @see {@link TreatMissingData} The AWS enum this type is derived from - aws-cdk-lib
 * @see {@link MetricAlarm} AWS SDK interface property for missing data treatment - `TreatMissingData` property
 * @see {@link https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudwatch.TreatMissingData.html}
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_PutMetricAlarm.html}
 */
export type MissingDataTreatment = TreatMissingData[keyof TreatMissingData] &
  MetricAlarm['TreatMissingData'];

//=============================================================================
// Metric Alarm Options and Config Interfaces
//=============================================================================
/**
 * Options for configuring CloudWatch metric alarms.
 *
 * @interface MetricAlarmOptions
 *
 */
export interface MetricAlarmOptions {
  /** Anomaly: Based on a standard deviation. Higher number means thicker band, lower number means thinner band.
   * Non-Anomaly: The value against which the specified statistic is compared.
   */
  warningThreshold: number | null;
  /**
   * Anomaly: Based on a standard deviation. Higher number means thicker band, lower number means thinner band.
   * Non-Anomaly: The value against which the specified statistic is compared.
   */
  criticalThreshold: number | null;
  /**
   * The polling period in seconds or minutes. Verify in AWS documentation before assuming the number is milliseconds, seconds or minutes.
   * Varies across services.
   */
  period: number;
  /**
   * The number of periods that are evaluated when tracking datapoints to alarm.
   * Creates a rolling observability window of n times the period.
   */
  evaluationPeriods: number;
  /**
   * The number of data points to alarm across all evaluation periods.
   */
  dataPointsToAlarm: number;
  /**
   * Valid Cloudwatch Alarm statistics see {@link ValidStatistic} for all valid statistic values
   * @use {@link StatFactory.Standard} for standard statistics
   * @use {@link StatFactory.Extended} for extended statistics
   *
   * @usage
   * ```typescript
   * statistic: StatFactory.Standard.average; // "Average"
   * statistic: StatFactory.Extended.p(90); // "p(90)"
   * statistic: StatFactory.Extended.tm(10,90); // "tm(10,90)"
   * ```
   */
  statistic: ValidStatistic;
  /**
   * Specifies how missing data points are treated during alarm evaluation. See {@link TreatMissingData} for valid
   * missing data treatment options
   * ---
   *
   * @usage
   * ```typescript
   * missingDataTreatment: TreatMissingData.BREACHING; // "breaching"
   * missingDataTreatment: TreatMissingData.NOT_BREACHING; // "notBreaching"
   * missingDataTreatment: TreatMissingData.IGNORE; // "ignore"
   * missingDataTreatment: TreatMissingData.MISSING; // "missing"
   * ```
   *
   */
  missingDataTreatment: MissingDataTreatment;
  /**
   * Represents Both an Enum and valid string literal values for CloudWatch alarm comparison operators.
   * This type extracts the actual string values from the `ComparisonOperator` enum
   * for type-safe handling of comparison operator strings.
   *
   * ---
   *
   * Valid values include:
   *
   * Standard threshold operators:
   * - `'GreaterThanOrEqualToThreshold'` - Triggers when metric value ≥ threshold
   * - `'GreaterThanThreshold'` - Triggers when metric value > threshold
   * - `'LessThanThreshold'` - Triggers when metric value < threshold
   * - `'LessThanOrEqualToThreshold'` - Triggers when metric value ≤ threshold
   *
   * Anomaly detection operators:
   * - `'LessThanLowerOrGreaterThanUpperThreshold'` - Triggers when metric value is outside the
   *   anomaly detection band (either below lower or above upper threshold)
   * - `'GreaterThanUpperThreshold'` - Triggers when metric value exceeds the upper threshold
   *   of the anomaly detection band
   * - `'LessThanLowerThreshold'` - Triggers when metric value falls below the lower threshold
   *   of the anomaly detection band
   *
   * ---
   *
   * @usage
   * ```typescript
   * comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD; // "GreaterThanOrEqualToThreshold"
   * comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD; // "GreaterThanThreshold"
   * comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD; // "LessThanThreshold"
   * comparisonOperator: ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD; // "LessThanOrEqualToThreshold"
   * comparisonOperator: ComparisonOperator.LESS_THAN_LOWER_OR_GREATER_THAN_UPPER_THRESHOLD; // "LessThanLowerOrGreaterThanUpperThreshold"
   * comparisonOperator: ComparisonOperator.GREATER_THAN_UPPER_THRESHOLD; // "GreaterThanUpperThreshold"
   * comparisonOperator: ComparisonOperator.LESS_THAN_LOWER_THRESHOLD; // "LessThanLowerThreshold"
   * ```
   *
   * ---
   *
   * @see {@link https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudwatch.ComparisonOperator.html}
   * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_PutMetricAlarm.html}
   * @see {@link ComparisonOperator} - Enum and Type declaration
   */
  comparisonOperator: ComparisonOperator;
}

/**
 * Configuration for creating CloudWatch metric alarms.
 * Defines the core settings and default options for a specific metric alarm.
 *
 * @interface MetricAlarmConfig
 *
 */
export interface MetricAlarmConfig {
  /**
   *   The tag key used to identify the Metric Alarm configuration.
   *   Resources with this tag will have alarms created according to this configuration.
   */
  tagKey: string;
  /**
   *   The name of the CloudWatch metric to monitor with this alarm.
   *   Must be a valid CloudWatch metric name.
   */
  metricName: string;
  /**
   *  The namespace of the CloudWatch metric.
   *  Metrics are grouped by namespaces (e.g., "AWS/EC2", "AWS/Lambda", etc...).
   */
  metricNamespace: string;
  /**
   *  Indicates whether alarms should be created by default when tag autoalarm:enabled = true.
   */
  defaultCreate: boolean;
  /**
   *  Indicates whether this alarm is based on anomaly detection.
   *  If true, the alarm will use anomaly detection models instead of standard metrics. If false, it defaults to static threshold alarms.
   */
  anomaly: boolean;
  /**
   * These are the Default values provided in the Alarm Config object.
   * @see {@link MetricAlarmOptions} for the structure of these options
   */
  defaults: MetricAlarmOptions;
}

export interface MetricAlarmConfigs
  extends Record<string, MetricAlarmConfig[]> {}
