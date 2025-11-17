import {MetricAlarmConfig} from '../types/index.mjs';
import {ComparisonOperator} from '@aws-sdk/client-cloudwatch';
import {TreatMissingData} from 'aws-cdk-lib/aws-cloudwatch';

export const LOGGROUP_CONFIGS: MetricAlarmConfig[] = [
  {
    tagKey: 'incoming-bytes',
    metricName: 'IncomingBytes',
    metricNamespace: 'AWS/Logs',
    defaultCreate: false,
    anomaly: false,
    defaults: {
      warningThreshold: null,
      criticalThreshold: null,
      period: 300,
      evaluationPeriods: 1,
      statistic: 'Maximum',
      dataPointsToAlarm: 1,
      comparisonOperator: ComparisonOperator.LessThanThreshold,
      missingDataTreatment: TreatMissingData.IGNORE,
    },
  },
  {
    tagKey: 'incoming-bytes-anomaly',
    metricName: 'IncomingBytes',
    metricNamespace: 'AWS/Logs',
    defaultCreate: false,
    anomaly: true,
    defaults: {
      warningThreshold: 2,
      criticalThreshold: 5,
      period: 300,
      evaluationPeriods: 1,
      statistic: 'Average',
      dataPointsToAlarm: 1,
      comparisonOperator: ComparisonOperator.GreaterThanUpperThreshold,
      missingDataTreatment: TreatMissingData.IGNORE,
    },
  },
];
