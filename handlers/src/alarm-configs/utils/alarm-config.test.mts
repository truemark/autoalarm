import {test, expect, describe} from 'vitest';
import {
  metricAlarmOptionsToString,
  parseStatisticOption,
} from './alarm-config.mjs';
import {Statistic} from '@aws-sdk/client-cloudwatch';

test('metricAlarmOptionsToString', async () => {
  expect(
    metricAlarmOptionsToString({
      warningThreshold: 1,
      criticalThreshold: 2,
      period: 2,
      evaluationPeriods: 3,
      statistic: 'Average',
      dataPointsToAlarm: 4,
      missingDataTreatment: 'missing',
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
    }),
  ).toBe('1/2/2/3/Average/4/GreaterThanOrEqualToThreshold/missing');
  // TODO Add more tests
});

/**
test('parseMetricAlarmOptions', async () => {
  // TODO Add tests
});
*/

/** parseStatisticOption test for valid Extended statistics.*/
describe('parseStatisticOption', () => {
  // Debug what's being imported
  console.log(
    'Imported metricAlarmOptionsToString:',
    typeof metricAlarmOptionsToString,
  );
  console.log('Imported parseStatisticOption:', typeof parseStatisticOption);
  console.log(
    'Is parseStatisticOption undefined?',
    parseStatisticOption === undefined,
  );
  console.log('Full import content:', {
    metricAlarmOptionsToString,
    parseStatisticOption,
  });

  // If it's an object with properties, inspect it
  if (
    typeof parseStatisticOption === 'object' &&
    parseStatisticOption !== null
  ) {
    console.log(
      'Properties of parseStatisticOption:',
      Object.keys(parseStatisticOption),
    );
  }
  // Test for Default Value
  test('returns default value for empty input', () => {
    expect(parseStatisticOption('', 'Average')).toBe('Average');
    expect(parseStatisticOption('   ', 'Maximum')).toBe('Maximum');
  });

  // Test for IQM Special Case - Interquartile mean is the trimmed mean of the middle 50% of values
  test('handles IQM special case correctly', () => {
    expect(parseStatisticOption('iqm', 'Average')).toBe('IQM');
    expect(parseStatisticOption('  iqm  ', 'Average')).toBe('IQM');
    expect(parseStatisticOption('IQM', 'Average')).toBe('IQM');
  });

  // Test for Standard Statistics
  test('correctly identifies standard statistics', () => {
    // Test each standard statistic
    Object.values(Statistic).forEach((stat) => {
      expect(parseStatisticOption(stat, 'Average')).toBe(stat);

      // Test with different casing
      expect(parseStatisticOption(stat.toLowerCase(), 'Average')).toBe(stat);
      expect(parseStatisticOption(stat.toUpperCase(), 'Average')).toBe(stat);

      // Test with whitespace
      expect(parseStatisticOption(`  ${stat}  `, 'Average')).toBe(stat);
    });
  });

  // Test for Percentile Statistics
  test('handles percentile statistics correctly', () => {
    const percentiles = [
      'p10',
      'p50',
      'p90',
      'p95',
      'p99',
      'p99',
      'tm10',
      'tm50',
      'tm90',
      'tm95',
      'ts10',
      'ts50',
      'wm10',
      'wm50',
    ];

    percentiles.forEach((percentile) => {
      expect(parseStatisticOption(percentile, 'Average')).toBe(percentile);

      // Test with different casing
      expect(parseStatisticOption(percentile.toUpperCase(), 'Average')).toBe(
        percentile,
      );

      // Test with whitespace
      expect(parseStatisticOption(`  ${percentile}  `, 'Average')).toBe(
        percentile,
      );
    });
  });

  // Test for Single-value Abbreviated Extended Statistics
  // According to docs: "They can only be abbreviated using lowercase letters when you specifying only one number"
  test('handles single-value abbreviated extended statistics correctly', () => {
    const singleValueStats = [
      // Format: [input, expected]
      ['TM90', 'tm90'], // Trimmed mean ignoring highest 10%
      ['TM99', 'tm99'], // Trimmed mean ignoring highest 1%
      ['WM98', 'wm98'], // Winsorized mean treating highest 2% as 98th percentile value
      ['TC90', 'tc90'], // Trimmed count ignoring highest 10%
      ['TS90', 'ts90'], // Trimmed sum ignoring highest 10%
    ];

    singleValueStats.forEach(([input, expected]) => {
      expect(parseStatisticOption(input, 'Average')).toBe(expected);

      // Test with whitespace
      expect(parseStatisticOption(`  ${input}  `, 'Average')).toBe(expected);
    });
  });

  // Test for Trimmed Mean with Range Extended Statistics
  test('handles trimmed mean with ranges correctly', () => {
    const tmRanges = [
      // Format: [input, expected]
      ['TM(10%:90%)', 'TM(10%:90%)'], // Trimmed mean using values between 10th and 90th percentiles
      ['tm(:95%)', 'TM(:95%)'], // Trimmed mean ignoring highest 5% values
      ['tm(5%:)', 'TM(5%:)'], // Trimmed mean ignoring lowest 5% values
      ['TM(80:500)', 'TM(80:500)'], // Trimmed mean using values between 80 and 500
      ['tm(:0.5)', 'TM(:0.5)'], // Trimmed mean using values up to 0.5
      ['tm(10%:90%)', 'TM(10%:90%)'], // Lowercase version should be capitalized
    ];

    tmRanges.forEach(([input, expected]) => {
      expect(parseStatisticOption(input, 'Average')).toBe(expected);

      // Test with whitespace
      expect(parseStatisticOption(`  ${input}  `, 'Average')).toBe(expected);
    });
  });

  // Test for Winsorized Mean with Range Extended Statistics
  test('handles winsorized mean with ranges correctly', () => {
    const wmRanges = [
      // Format: [input, expected]
      ['WM(10%:90%)', 'WM(10%:90%)'], // Winsorized mean treating values outside 10-90% as boundary values
      ['WM(:95%)', 'WM(:95%)'], // Winsorized mean treating highest 5% values as 95th percentile value
      ['wm(5%:)', 'WM(5%:)'], // Winsorized mean treating lowest 5% values as 5th percentile value
      ['WM(100:2000)', 'WM(100:2000)'], // Winsorized mean treating values outside 100-2000 as boundary values
      ['wm(10%:90%)', 'WM(10%:90%)'], // Lowercase version should be capitalized
    ];

    wmRanges.forEach(([input, expected]) => {
      expect(parseStatisticOption(input, 'p90')).toBe(expected);

      // Test with whitespace
      expect(parseStatisticOption(`  ${input}  `, 'Average')).toBe(expected);
    });
  });

  // Test for Trimmed Count with Range Extended Statistics
  test('handles trimmed count with ranges correctly', () => {
    const tcRanges = [
      // Format: [input, expected]
      ['TC(10%:90%)', 'TC(10%:90%)'], // Count of values between 10th and 90th percentiles
      ['TC(:95%)', 'TC(:95%)'], // Count of values up to 95th percentile
      ['TC(5%:)', 'TC(5%:)'], // Count of values above 5th percentile
      ['TC(0.005:0.030)', 'TC(0.005:0.030)'], // Count of values between 0.005 and 0.030
      ['tc(10%:90%)', 'TC(10%:90%)'], // Lowercase version should be capitalized
    ];

    tcRanges.forEach(([input, expected]) => {
      expect(parseStatisticOption(input, 'Average')).toBe(expected);

      // Test with whitespace
      expect(parseStatisticOption(`  ${input}  `, 'Average')).toBe(expected);
    });
  });

  // Test for Trimmed Sum with Range Extended Statistics
  test('handles trimmed sum with ranges correctly', () => {
    const tsRanges = [
      // Format: [input, expected]
      ['TS(10%:90%)', 'TS(10%:90%)'], // Sum of values between 10th and 90th percentiles
      ['TS(:95%)', 'TS(:95%)'], // Sum of values up to 95th percentile
      ['TS(80%:)', 'TS(80%:)'], // Sum of values above 80th percentile
      ['TS(100:2000)', 'TS(100:2000)'], // Sum of values between 100 and 2000
      ['ts(10%:90%)', 'TS(10%:90%)'], // Lowercase version should be capitalized
    ];

    tsRanges.forEach(([input, expected]) => {
      expect(parseStatisticOption(input, 'Average')).toBe(expected);

      // Test with whitespace
      expect(parseStatisticOption(`  ${input}  `, 'Average')).toBe(expected);
    });
  });

  // Test mismatched values
  test('handles percentile rank statistics correctly', () => {
    const prRanges = [
      // Format: [input, expected]
      ['PR(123%:300)', 'Average'], // Percentage of data points with value ≤ 300
      ['PR(100%:2000)', 'Average'], // Percentage of data points with value between 100 and 2000
      ['pr(23%:300)', 'Average'], // Lowercase version should be capitalized
    ];

    prRanges.forEach(([input, expected]) => {
      expect(parseStatisticOption(input, 'Average')).toBe(expected);

      // Test with whitespace
      expect(parseStatisticOption(`  ${input}  `, 'Average')).toBe(expected);
    });
  });

  // Test for Percentile Rank (PR) Extended Statistics
  test('handles percentile rank statistics correctly', () => {
    const prRanges = [
      // Format: [input, expected]
      ['PR(:300)', 'PR(:300)'], // Percentage of data points with value ≤ 300
      ['PR(100:2000)', 'PR(100:2000)'], // Percentage of data points with value between 100 and 2000
      ['pr(:300)', 'PR(:300)'], // Lowercase version should be capitalized
    ];

    prRanges.forEach(([input, expected]) => {
      expect(parseStatisticOption(input, 'Average')).toBe(expected);

      // Test with whitespace
      expect(parseStatisticOption(`  ${input}  `, 'Average')).toBe(expected);
    });
  });

  // Test for Invalid Values based on AWS documentation rules
  test('returns default value for invalid statistics', () => {
    const invalidValues = [
      'NotAStat', // Not a valid statistic
      'p101', // Percentile out of range
      'tm101', // Trimmed mean out of range
      'wm101', // Winsorized mean out of range
      'TC(zz%:300%)', // Percentage over 100%
      'PR(abc)', // Invalid percentile rank format
      'TM(10:90:80)', // Too many values in range
      'p', // Incomplete
      'tm', // Incomplete
      'TC()', // Empty range
      'PR(::)', // Invalid format
      'CP(:123)', // CP is not a valid AWS extended statistic
      'TM 90', // Space not allowed
      'wm  -(10:90)', // hyphen not allowed
      'tm99%', // Wrong format for single value
      'TMzz', // Uppercase abbreviated format is invalid
      'TS(101%:)', // Percentage over 100%
      'WM(:-1)', // Negative value
    ];

    invalidValues.forEach((invalid) => {
      expect(parseStatisticOption(invalid, 'Average')).toBe('Average');
    });
  });

  // Test for Edge Cases based on AWS documentation
  test('handles edge cases correctly', () => {
    // Edge case: Mixed case with spaces for standard statistics
    expect(parseStatisticOption('  aVeRaGe  ', 'Maximum')).toBe('Average');

    // Edge case: Equivalent notations according to docs
    expect(parseStatisticOption('tm99', 'Average')).toBe('tm99');
    expect(parseStatisticOption('TM(:99%)', 'Average')).toBe('TM(:99%)');

    // Edge case: IQM is equivalent to TM(25%:75%)
    // This is just to document the relationship, not necessarily testable here
    expect(parseStatisticOption('iqm', 'Average')).toBe('IQM');

    // Edge case: Decimal place precision in percentiles
    expect(parseStatisticOption('p99.9', 'Average')).toBe('Average');
    expect(parseStatisticOption('TM(10.5%:90.5%)', 'Average')).toBe(
      'TM(10.5%:90.5%)',
    );

    // Edge case: Valid format with minimal values
    expect(parseStatisticOption('p0', 'Average')).toBe('Average');
    expect(parseStatisticOption('p100', 'Average')).toBe('Average');
  });
});
