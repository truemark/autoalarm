import {test, expect} from 'vitest';
import {metricAlarmOptionsToString} from './alarm-config.mjs';

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

test('parseMetricAlarmOptions', async () => {
  // TODO Add tests
});
