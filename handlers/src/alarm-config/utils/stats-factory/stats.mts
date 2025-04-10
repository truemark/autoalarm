/**
 * this class is a loose mirror of the `aws-cdk-lib` Stats Class
 * This class was created due to substantial overlap between SDK and CDK libs
 * Specifically, Extended statistics in the CDK lib follow a different pattern than in the SDK (Which AutoAlarm uses to create alarms)
 * compatible with AWS CloudWatch's expected values for `ExtendedStatistic` and `Statistic`.
 *
 * ---
 *
 * @example
 *
 * ```typescript
 * // Standard Statistics
 * Stats.SAMPLE_COUNT; // "SampleCount"
 * Stats.AVERAGE;     // "Average"
 * Stats.SUM;         // "Sum"
 * Stats.MINIMUM;     // "Minimum"
 * Stats.MAXIMUM;     // "Maximum"
 * Stats.IQM;        // "IQM"
 *
 * // Extended Statistics (both long and short forms of stats supported and can be used interchangeably for both single and double value function calls):
 *
 * // Simple percentiles
 *   Stats.percentile(90); // "p90"
 *   Stats.p(50);          // "p50"
 *
 * // Trimmed mean/statistics with percentage bounds
 *   Stats.trimmedMean(90);      // "tm90"
 *   Stats.tm(10, 90);           // "TM(10%:90%)"
 *
 * // Winsorized mean
 *   Stats.winsorizedMean(90);   // "wm90"
 *   Stats.wm(10, 90);           // "WM(10%:90%)"
 *
 * // Trimmed count and sum
 *   Stats.trimmedCount(90);     // "tc90"
 *   Stats.tc(5, 95);            // "TC(5%:95%)"
 *   Stats.trimmedSum(90);       // "ts90"
 *   Stats.ts(10, 90);           // "TS(10%:90%)"
 *
 * // Percentile rank (absolute values)
 *   Stats.percentileRank(300);       // "PR(0:300)"
 *   Stats.pr(100, 2000);             // "PR(100:2000)"
 * ```
 *
 * ---
 *
 * @see {@link Stats} for reference of origin class
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html} for AWS documentation
 * @see {@link https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-cloudwatch/Interface/PutMetricAlarmCommandInput/} - JS SDK documentation
 */
export abstract class Stats {
  static readonly SAMPLE_COUNT = 'SampleCount';
  static readonly AVERAGE = 'Average';
  static readonly SUM = 'Sum';
  static readonly MINIMUM = 'Minimum';
  static readonly MAXIMUM = 'Maximum';
  static readonly IQM = 'IQM';

  /**
   * Percentiles are specified as pXX, e.g., "p90" for 90th percentile.
   */
  static percentile(percentile: number): string {
    if (percentile <= 0 || percentile > 100) {
      throw new Error('Percentile must be between 0 and 100 (exclusive).');
    }
    return `p${percentile}`;
  }

  /**
   * Alias for percentile method.
   */
  static p(percentile: number): string {
    return this.percentile(percentile);
  }

  /**
   * Trimmed mean or TM, specified as TM(X%:Y%) or tmXX.
   * If only one argument is given, it defaults to lower 0%.
   */
  static trimmedMean(p1?: number, p2?: number): string {
    if (p1 !== undefined && p2 === undefined) {
      if (p1 <= 0 || p1 >= 100)
        throw new Error(
          'For single-number TM, p1 must be between 0 and 100 (exclusive).',
        );
      return `tm${p1}`;
    } else if (p1 !== undefined && p2 !== undefined) {
      return `TM(${p1}%:${p2}%)`;
    } else {
      throw new Error('trimmedMean requires 1 or 2 parameters.');
    }
  }

  /**
   * Alias for trimmedMean method.
   */
  static tm(p1: number, p2?: number): string {
    return this.trimmedMean(p1, p2);
  }

  /**
   * Winsorized mean or WM, uses format WM(X%:Y%) or wmXX.
   * If only one argument is given, it defaults to lower 0%.
   */
  static winsorizedMean(p1: number, p2?: number): string {
    if (p2 === undefined) {
      if (p1 <= 0 || p1 > 100) {
        throw new Error(
          'Winsorized percentage must be between 0 and 100 (exclusive).',
        );
      }
      return `wm${p1}`;
    } else {
      this.validateBounds(p1, p2);
      return `WM(${p1}%:${p2}%)`;
    }
  }

  /**
   * Alias for winsorizedMean method.
   */
  static wm(p1: number, p2?: number): string {
    return this.winsorizedMean(p1, p2);
  }

  /**
   * Trimmed count or TC, uses format TC(X%:Y%) or tcXX.
   * If only one argument is given, it defaults to lower 0%.
   */
  static trimmedCount(p1: number, p2?: number): string {
    if (p2 === undefined) {
      if (p1 <= 0 || p1 > 100) {
        throw new Error(
          'Trimmed count percentage must be between 0 and 100 (exclusive).',
        );
      }
      return `tc${p1}`;
    } else {
      this.validateBounds(p1, p2);
      return `TC(${p1}%:${p2}%)`;
    }
  }

  /**
   * Alias for trimmedCount method.
   */
  static tc(p1: number, p2?: number): string {
    return this.trimmedCount(p1, p2);
  }

  /**
   * Trimmed sum or TS, uses format TS(X%:Y%) or tsXX.
   * If only one argument is given, it defaults to lower 0%.
   */
  static trimmedSum(p1: number, p2?: number): string {
    if (p2 === undefined) {
      if (p1 <= 0 || p1 > 100) {
        throw new Error(
          'Trimmed sum percentage must be between 0 and 100 (exclusive).',
        );
      }
      return `ts${p1}`;
    } else {
      this.validateBounds(p1, p2);
      return `TS(${p1}%:${p2}%)`;
    }
  }

  /**
   * Alias for trimmedSum method.
   */
  static ts(p1: number, p2?: number): string {
    return this.trimmedSum(p1, p2);
  }

  /**
   * Percentile Rank or PR, specified with absolute values: PR(n:m).
   * Single number returns PR(0:v1).
   */
  static percentileRank(v1: number, v2?: number): string {
    if (v2 === undefined) {
      return `PR(0:${v1})`;
    } else {
      if (v2 <= v1) {
        throw new Error(
          'Second value must be greater than first value for Percentile Rank.',
        );
      }
      return `PR(${v1}:${v2})`;
    }
  }

  /**
   * Alias for percentileRank method.
   */
  static pr(v1: number, v2?: number): string {
    return this.percentileRank(v1, v2);
  }

  /**
   * Helper function to validate percentile bounds [X%:Y%].
   */
  private static validateBounds(p1: number, p2: number): void {
    if (!(p1 >= 0 && p1 < p2 && p2 <= 100)) {
      throw new Error(
        `Invalid percentile bounds: must satisfy 0 <= p1 < p2 <= 100 (got p1=${p1}, p2=${p2})`,
      );
    }
  }
}
