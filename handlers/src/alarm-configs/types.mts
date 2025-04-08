//=============================================================================
// Alarm Config Types and Interfaces
//=============================================================================
import {ComparisonOperator, TreatMissingData} from 'aws-cdk-lib/aws-cloudwatch';
import {ExtStatPrefix, StandardStatistic} from './enums.mjs';

/**
 * Represents valid string literal values for CloudWatch alarm comparison operators.
 * This type extracts the actual string values from the `ComparisonOperator` enum
 * for type-safe handling of comparison operator strings.
 *
 * The type uses indexed access with the enum to create a union of all possible enum values,
 * then intersects with string to ensure they are treated as string literals.
 *
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

/**
 * Represents parameter patterns for CloudWatch extended statistics.
 * These patterns capture the different parameter formats allowed by the CloudWatch API.
 *
 * Supported formats:
 * - `(n)` - Single numeric parameter (e.g., "p(90)", "tm(90)")
 * - `(n:m)` - Two numeric parameters (e.g., "PR(100:2000)")
 * - `(:m)` - Undefined first parameter (used with Percentile Rank)
 * - `(n%:m%)` - Two percentage parameters (e.g., "TM(10%:90%)")
 *
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html}
 *      CloudWatch API documentation for valid statistic formats
 */
type ExtendedStatParam =
  | (`(${number})` & string) // Single parameter
  | (`(${number}:${number})` & string) // Two simple number parameters
  | (`(:${number})` & string) // Undefined first parameter for Percentile Rank
  | (`(${number}%:${number}%)` & string); // Two percentage parameters

/**
 * Represents valid string literal values for CloudWatch extended statistics.
 * This type captures all possible patterns of extended statistics that can be
 * used with the CloudWatch API.
 *
 * The type uses a mapped type to generate pattern templates for each prefix in
 * the ExtStatPrefix enum, creating union types that match both
 * single-parameter and two-parameter formats.
 *
 * @template T - An enum or object containing prefix values for extended statistics
 *
 * Extended statistics follow these patterns according to AWS documentation:
 * - Percentile: "p90" (90th percentile)
 * - Trimmed Mean: "tm90" or "TM(10%:90%)"
 * - Trimmed Count: "tc90" or "TC(10%:90%)"
 * - Trimmed Sum: "ts90" or "TS(10%:90%)"
 * - Winsorized Mean: "wm90" or "WM(10%:90%)"
 * - Interquartile Mean: "IQM" (also available as a standard statistic)
 * - Percentile Rank: "PR(n:m)" where n and m are absolute values of the metric
 *
 * For percentage-based parameters (TM, TC, TS, WM), values must be between 10 and 90 inclusive.
 *
 * Note that when calling PutMetricAlarm and specifying a MetricName, you must specify
 * either Statistic or ExtendedStatistic but not both.
 *
 * @see {@link ExtStatPrefix} Enum containing prefixes for extended statistics
 * @see {@link ExtendedStatParam} Type for extended statistics parameter patterns
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html}
 *      CloudWatch statistics documentation
 */
export type ValidExtendedStat = {
  [K in keyof ExtStatPrefix]: ExtStatPrefix[K] extends string
    ? `${ExtStatPrefix[K]}(${ExtendedStatParam})` & string
    : never;
}[keyof ExtStatPrefix];

/**
 * Represents all valid CloudWatch statistics that can be used with the AWS CloudWatch API.
 * This comprehensive type includes both standard statistics and extended statistics.
 *
 * Valid statistics fall into two categories:
 *
 * 1. Standard Statistics:
 *    - "Average" - The average of values during the period
 *    - "Maximum" - The highest value observed during the period
 *    - "Minimum" - The lowest value observed during the period
 *    - "SampleCount" - The number of data points used for calculation
 *    - "Sum" - The sum of all values during the period
 *    - "IQM" - Interquartile mean (trimmed mean of the middle 50%)
 *
 * 2. Extended Statistics (according to AWS documentation):
 *    - "p90" - 90th percentile
 *    - "tm90" - Trimmed mean removing the top 10%
 *    - "tc90" - Trimmed count excluding the top 10%
 *    - "ts90" - Trimmed sum excluding the top 10%
 *    - "wm90" - Winsorized mean with boundary at 90%
 *    - "IQM" - Interquartile mean (also available as a standard statistic)
 *    - "PR(n:m)" - Percentile rank where n and m are values of the metric
 *    - "TC(X%:X%)" - Trimmed count with X between 10 and 90 inclusive
 *    - "TM(X%:X%)" - Trimmed mean with X between 10 and 90 inclusive
 *    - "TS(X%:X%)" - Trimmed sum with X between 10 and 90 inclusive
 *    - "WM(X%:X%)" - Winsorized mean with X between 10 and 90 inclusive
 *
 * Important: When calling PutMetricAlarm and specifying a MetricName, you must specify
 * either Statistic or ExtendedStatistic but not both.
 *
 * @see {@link StandardStatistic} Enum defining standard CloudWatch statistics
 * @see {@link ExtStatPrefix} Enum containing prefixes for extended statistics
 * @see {@link ValidExtendedStat} Type for extended statistics patterns
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricStatistics.html}
 * @see {@link https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cloudwatch/command/PutMetricAlarmCommand/}
 *
 * @example
 * // Using standard statistics
 * const standardStat: ValidStatistic = "Average";
 *
 * @example
 * // Using extended statistics
 * const percentile: ValidStatistic = "p90";
 * const trimmedMean: ValidStatistic = "TM(10%:90%)";
 */
export type ValidStatistic =
  | StandardStatistic[keyof StandardStatistic] & string
  | ValidExtendedStat & string;

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
 * @see {@link TreatMissingData} The enum this type is derived from
 * @see {@link https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudwatch.TreatMissingData.html}
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_PutMetricAlarm.html}
 */
export type MissingDataTreatment = TreatMissingData[keyof TreatMissingData] &
  string;

/** Alarm Config Interfaces*/

/**
 * Options for configuring CloudWatch metric alarms.
 * Applicable to both standard and anomaly detection alarms.
 *
 * @interface MetricAlarmOptions
 *
 * @property {number | null} warningThreshold
 *   For standard alarms: The numeric value to compare against the specified statistic for warning level.
 *   For anomaly detection: The number of standard deviations that forms the warning band width.
 *               Higher values create wider bands (less sensitive), lower values create narrower bands (more sensitive).
 *
 * @property {number | null} criticalThreshold
 *   For standard alarms: The numeric value to compare against the specified statistic for critical level.
 *   For anomaly detection: The number of standard deviations that forms the critical band width.
 *               Higher values create wider bands (less sensitive), lower values create narrower bands (more sensitive).
 *
 * @property {number} period
 *   The time period, in seconds, over which the specified statistic is applied.
 *   Common values: 60 (1 minute), 300 (5 minutes), etc.
 *
 * @property {number} evaluationPeriods
 *   The number of consecutive periods during which the value of the metric must exceed the threshold to trigger the alarm.
 *
 * @property {number} dataPointsToAlarm
 *   The number of data points within the evaluation periods that must breach the threshold to trigger the alarm.
 *   Must be less than or equal to evaluationPeriods.
 *
 * @property {string} statistic
 *   The statistic for the metric associated with the alarm.
 *   Examples: "Average", "Sum", "Minimum", "Maximum", "SampleCount", or percentile statistics like "p99"
 *
 * @property {MissingDataTreatment} missingDataTreatment
 *   Specifies how missing data points are handled when evaluating the alarm.
 *
 * @property {ValidComparisonOperator} comparisonOperator
 *   The arithmetic operation used to compare the specified statistic and threshold.
 *   Determines whether the alarm triggers when the metric is greater than, less than, etc. the threshold.
 */
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
  statistic: ValidStatistic;

  // Missing data treatment
  missingDataTreatment: MissingDataTreatment;

  // The arithmetic operation to use when comparing the specified statistic and threshold
  comparisonOperator: ValidComparisonOperator;
}

/**
 * Configuration for creating CloudWatch metric alarms.
 * Defines the core settings and default options for a specific metric alarm.
 *
 * @interface MetricAlarmConfig
 *
 * @property {string} tagKey
 *   The tag key used to identify the Metric Alarm configuration.
 *   Resources with this tag will have alarms created according to this configuration.
 *
 * @property {string} metricName
 *   The name of the CloudWatch metric to monitor with this alarm.
 *   Must be a valid CloudWatch metric name.
 *
 * @property {string} metricNamespace
 *   The namespace of the CloudWatch metric.
 *   Metrics are grouped by namespaces (e.g., "AWS/EC2", "AWS/Lambda", etc...).
 *
 * @property {boolean} defaultCreate
 *   Indicates whether alarms should be created by default for resources matching the tag key.
 *   When true, alarms will be automatically created unless explicitly disabled for a resource via tag
 *   (e.g., "autoalarm:4xx-erros: "-/-")
 *   When false, alarms will only be created when explicitly enabled for a resource.
 *
 * @property {boolean} anomaly
 *   Specifies whether this is an anomaly detection alarm.
 *   When true, the alarm uses CloudWatch's anomaly detection instead of static thresholds.
 *   Affects how thresholds in the MetricAlarmOptions are interpreted.
 *
 * @property {MetricAlarmOptions} defaults
 *   Default alarm options to use when creating alarms with this configuration.
 *   Includes thresholds, evaluation periods, statistics, and other alarm behaviors.
 *   These defaults can be overridden on a per-resource basis if needed.
 */
export interface MetricAlarmConfig {
  tagKey: string;
  metricName: string;
  metricNamespace: string;
  defaultCreate: boolean;
  anomaly: boolean;
  defaults: MetricAlarmOptions;
}

export interface MetricAlarmConfigs
  extends Record<string, MetricAlarmConfig[]> {}
