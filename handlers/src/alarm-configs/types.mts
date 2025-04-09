//=============================================================================
// Alarm Config Types and Interfaces
//=============================================================================
import {
  ComparisonOperator,
  TreatMissingData,
  Stats,
} from 'aws-cdk-lib/aws-cloudwatch';
import * as v from 'valibot';

//=============================================================================
// Comparison Operator Typing and Schema
//=============================================================================
/**
 * Represents valid string literal values for CloudWatch alarm comparison operators.
 * This type extracts the actual string values from the `ComparisonOperator` enum
 * for type-safe handling of comparison operator strings.
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
 * @see {@link https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudwatch.ComparisonOperator.html}
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_PutMetricAlarm.html}
 */
export type ValidComparisonOperator = {
  [K in keyof ComparisonOperator]: ComparisonOperator[K];
}[keyof ComparisonOperator];

// Valibot schema for ValidComparisonOperator
export const ValidComparisonOperatorSchema = v.enum(ComparisonOperator);

//=============================================================================
// Statistic Typing and Schemas
//=============================================================================
//

/**
 * The `StatMethods` object provides a centralized, type-safe reference
 * for AWS CloudWatch standard statistics and extended statistics.
 * Using this object ensures that AutoAlarm aligns with the latest AWS SDK CloudWatch statistics.
 *
 * Note: TSDOC does not play nicely with an object as a const. Use Auto Complete to see available methods.
 * Or visit the typefile.
 *
 * @type {Stats}
 *
 * @example
 * // Standard statistic usage
 * const avgStat = StatMethods.Standard.average; // "Average"
 *
 * // Extended statistic usage
 * const p90 = StatMethods.Extended.p(90); // "p(90)"
 * const trimmedMean = StatMethods.Extended.tm(10, 90); // "tm(10,90)"
 *
 * Note: TSDOC does not play nicely with an object as a const. Use Auto Complete to see available methods.
 * Or visit the typefile.
 *
 * @see {@link Statistic} Enum defining standard CloudWatch statistics - deprecated reference only
 * @see {@link Stats} Class from AWS CDK for generating standard statistics implemented in this object mapping
 * @see {@link https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-cloudwatch/Interface/PutMetricAlarmCommandInput/}
 */
export const StatMethods = {
  /**
   * Standard CloudWatch statistics.
   */
  Standard: {
    /** Number of data points used for the statistical calculation. */
    samplecount: Stats.SAMPLE_COUNT,

    /** The average value (Sum / SampleCount). */
    average: Stats.AVERAGE,

    /** Sum of metric values. */
    sum: Stats.SUM,

    /** Minimum metric value observed. */
    minimum: Stats.MINIMUM,

    /** Maximum metric value observed. */
    maximum: Stats.MAXIMUM,

    /** Interquartile mean, identical to trimmed mean from 25% to 75%. */
    iqm: Stats.IQM,
  },

  /**
   * Extended statistics computed with additional parameters defining boundaries or thresholds.
   */
  Extended: {
    /** Percentile (e.g., p(90)). */
    p: (percentile: number) => Stats.p(percentile),

    /** Percentile (alias of `p`). */
    percentile: (percentile: number) => Stats.percentile(percentile),

    /** Trimmed mean (e.g., tm(10,90) or tm(90)). */
    tm: (p1: number, p2?: number) => Stats.tm(p1, p2),

    /** Trimmed mean (alias of `tm`). */
    trimmedMean: (p1: number, p2?: number) => Stats.trimmedMean(p1, p2),

    /** Winsorized mean (e.g., wm(10,90) or wm(90)). */
    wm: (p1: number, p2?: number) => Stats.wm(p1, p2),

    /** Winsorized mean (alias of `wm`). */
    winsorizedMean: (p1: number, p2?: number) => Stats.winsorizedMean(p1, p2),

    /** Trimmed count (e.g., tc(10,90) or tc(90)). */
    tc: (p1: number, p2?: number) => Stats.tc(p1, p2),

    /** Trimmed count (alias of `tc`). */
    trimmedCount: (p1: number, p2?: number) => Stats.trimmedCount(p1, p2),

    /** Trimmed sum (e.g., ts(10,90) or ts(90)). */
    ts: (p1: number, p2?: number) => Stats.ts(p1, p2),

    /** Trimmed sum (alias of `ts`). */
    trimmedSum: (p1: number, p2?: number) => Stats.trimmedSum(p1, p2),

    /** Percentile rank (e.g., pr(100,2000) or pr(300)). */
    pr: (v1: number, v2?: number) => Stats.pr(v1, v2),

    /** Percentile rank (alias of `pr`). */
    percentileRank: (v1: number, v2?: number) => Stats.percentileRank(v1, v2),
  },
} as const;


/**
 * Represents valid formatted method call strings for CloudWatch extended statistics.
 *
 * Generates all possible extended statistic method call patterns from
 * methods defined in {@link StatMethods.Extended}. This includes:
 *
 * - Percentiles (`p(90)`): Calculations based on a specific percentile.
 * - Trimmed/Winsorized Mean (`tm(10,90)`, `wm(95)`): Statistical averages with boundaries.
 * - Trimmed Count/Sum (`tc(25,75)`, `ts(10)`): Counts or sums within a specified percentile range.
 * - Percentile Rank (`pr(100,2000)`): Percentage of values within a given numeric range.
 *
 * @example
 * ```typescript
 * const validCall: ValidExtendedStatMethodCall = 'tm(10,90)'; // valid
 * const invalidCall: ValidExtendedStatMethodCall = 'xyz(5)'; // Error: invalid statistic pattern
 * ```
 *
 * @see {@link StatMethods} - Reference object for generating statistic strings.
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html | AWS CloudWatch statistics documentation}
 */
export type ValidExtendedStatMethodCall = {
  [K in keyof typeof StatMethods.Extended]: (typeof StatMethods.Extended)[K] extends (
    p1: number,
    p2?: number,
  ) => unknown
    ? `${K}(${number},${number}) ` | `${K}(${number})`
      : never;
}[keyof typeof StatMethods.Extended];


/**
 * Represents all valid extended statistic strings acceptable by CloudWatch APIs,
 * either in direct method-call format or precomputed string literal values.
 *
 * This type combines formatted method call strings and computed string literals.
 *
 * Useful when explicitly typing configurations or inputs for CloudWatch alarms and metrics.
 *
 * @example
 * ```typescript
 * // Method call literal
 * const methodCallStat: ValidExtendedStat = 'wm(95)';
 *
 * // Computed string from method call
 * const computedStat: ValidExtendedStat = StatMethods.Extended.wm(95);
 * ```
 *
 * @see {@link StatMethods.Extended} for generating these extended statistics.
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricStatistics.html | AWS CloudWatch GetMetricStatistics API documentation}
 */
export type ValidExtendedStat = ValidExtendedStatMethodCall


/**
 * Type representing valid standard CloudWatch statistics string literals.
 *
 * This type extracts the standard statistic values from the StatMethods.Standard object,
 * preserving their exact string literal types.
 *
 * The mapped type ensures that all values from StatMethods.Standard are properly typed,
 *
 * @example
 * // Valid standard statistics:
 * // "SampleCount" | "Average" | "Sum" | "Minimum" | "Maximum" | "IQM"
 *
 * const stat: StandardStat = "Average"; // Valid
 * const invalidStat: StandardStat = "p(90)"; // Type error - extended statistic
 *
 * @see {@link Statistic} for the CDK enumeration of standard statistics - deprecated, ref only
 * @see {@link StatMethods.Standard} Object containing the standard statistic constants
 *
 */
export type StandardStat =
  (typeof StatMethods.Standard)[keyof typeof StatMethods.Standard];


/**
 * Represents all valid CloudWatch statistics that can be used with the AWS CloudWatch API.
 *
 * 1. Standard Statistics:
 *    - "SampleCount" - The count (number) of data points used for statistical calculation
 *    - "Average" - The value of Sum / SampleCount during the specified period
 *    - "Sum" - All values submitted for the matching metric added together
 *    - "Minimum" - The lowest value observed during the specified period
 *    - "Maximum" - The highest value observed during the specified period
 *    - "IQM" - Interquartile mean (trimmed mean of the middle 50%, equivalent to TM(25,75))
 *
 * 2. Extended Statistics:
 *    - "p(N)" - Nth percentile (e.g., "p(90)" for 90th percentile)
 *    - "tm(N)" - Trimmed mean including values from 0 to Nth percentile
 *    - "tm(N,M)" - Trimmed mean including values between Nth and Mth percentiles
 *    - "wm(N)" - Winsorized mean with upper boundary at Nth percentile
 *    - "wm(N,M)" - Winsorized mean with boundaries at Nth and Mth percentiles
 *    - "tc(N)" - Trimmed count of values up to Nth percentile
 *    - "tc(N,M)" - Trimmed count of values between Nth and Mth percentiles
 *    - "ts(N)" - Trimmed sum of values up to Nth percentile
 *    - "ts(N,M)" - Trimmed sum of values between Nth and Mth percentiles
 *    - "pr(V)" - Percentile rank showing percentage of values at or below V
 *    - "pr(V,W)" - Percentile rank showing percentage of values between V and W
 *
 * Both Standard and Extended statistics are generated using the static methods in the Stats class:
 *
 * @example
 * // Generate standard statistics using StatMethods.Standard
 * const avgStat = StatMethods.Standard.average; // "Average"
 * const maxStat = StatMethods.Standard.maximum; // "Maximum"
 *
 * @example
 * // Generate extended statistics using StatMethods.Extended
 * const p90 = StatMethods.Extended.p(90); // "p(90)"
 * const trimmedMean = StatMethods.Extended.tm(10, 90); // "tm(10,90)"
 * const winsorizedMean = StatMethods.Extended.wm(95); // "wm(95)"
 * const percentileRank = StatMethods.Extended.pr(100, 2000); // "pr(100,2000)"
 *
 * Important: When calling CloudWatch APIs like PutMetricAlarm and specifying a MetricName,
 * you must specify either a standard Statistic or an ExtendedStatistic, but not both.
 *
 * @see {@link StatMethods} Object containing methods to generate statistic strings
 * @see {@link StandardStat} Type for standard statistics
 * @see {@link ValidExtendedStat} Type for extended statistics
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html}
 */
export type ValidStatistic = StandardStat | ValidExtendedStat;


//=============================================================================
// Missing Data Treatment Typing and Schema
//=============================================================================

/**
 * Specifies how CloudWatch handles missing data points when evaluating an alarm.
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
 * @see {@link TreatMissingData} The AWS enum this type is derived from
 * @see {@link https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudwatch.TreatMissingData.html}
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_PutMetricAlarm.html}
 */
export type MissingDataTreatment = TreatMissingData[keyof TreatMissingData] &
  string;


//=============================================================================
// Metric Alarm Options and Config Interfaces and Schemas
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
   *Anomaly: Based on a standard deviation. Higher number means thicker band, lower number means thinner band.
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
  // Number of data points to alarm across the evaluation periods.
  dataPointsToAlarm: number;
  /**
   * Valid Cloudwatch Alarm statistics see {@link ValidStatistic} for all valid statistic values
   * @use {@link StatMethods.Standard} for standard statistics
   * @use {@link StatMethods.Extended} for extended statistics
   * @example
   * statistic: StatMethods.Standard.average; // "Average"
   * statistic: StatMethods.Extended.p(90); // "p(90)"
   * statistic: StatMethods.Extended.tm(10,90); // "tm(10,90)"
   */
  statistic: ValidStatistic;
  /**
   * Specifies how missing data points are treated during alarm evaluation. See {@link MissingDataTreatment} for valid treatment options
   */
  missingDataTreatment: MissingDataTreatment;
  /**
   * The arithmetic operation used to compare the specified statistic and threshold.
   * checkout {@link ValidComparisonOperator} for valid comparison operator values
   * @use {@link ComparisonOperator} from aws for standard comparison operators
   * @example
   * compareisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD // "GreaterThanOrEqualToThreshold";
   * comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD // "GreaterThanThreshold";
   */
  comparisonOperator: ValidComparisonOperator;
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

