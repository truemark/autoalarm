/**
 * @fileoverview RDS_CLUSTER alarm configuration definitions.
 *
 * This file contains the default configurations for all supported RDS_CLUSTER CloudWatch alarms managed by AutoAlarm.
 *
 * @requires
 * - Approval from Owners Team lead and consultation before adding new alarms
 * - Anomaly Alarms can only use the following comparison operators: GreaterThanUpperThreshold, LessThanLowerOrGreaterThanUpperThreshold, LessThanLowerThreshold
 *
 * @Owners DB WARDEN
 */

import {MetricAlarmConfig} from '../../types/index.mjs';
import {ComparisonOperator} from '@aws-sdk/client-cloudwatch';
import {TreatMissingData} from 'aws-cdk-lib/aws-cloudwatch';

/**
 * _RDS_CLUSTER alarm configuration definitions.
 * Implements the {@link MetricAlarmConfig} interface.
 * Used to map a tag key to a CloudWatch metric name and namespace to default alarm configurations {@link MetricAlarmOptions}.
 */
export const RDS_CLUSTER_CONFIGS: MetricAlarmConfig[] = [
  // 1) CPU - Static Only
  {
    tagKey: 'cpu',
    metricName: 'CPUUtilization',
    metricNamespace: 'AWS/RDS',
    defaultCreate: false,
    anomaly: false,
    defaults: {
      warningThreshold: 90,
      criticalThreshold: 95,
      period: 600,
      evaluationPeriods: 1,
      statistic: 'Maximum',
      dataPointsToAlarm: 1,
      comparisonOperator: ComparisonOperator.GreaterThanThreshold,
      missingDataTreatment: TreatMissingData.IGNORE,
    },
  },

  // 2) DatabaseConnections - Anomaly

  {
    tagKey: 'db-connections-anomaly',
    metricName: 'DatabaseConnections',
    metricNamespace: 'AWS/RDS',
    defaultCreate: true,
    anomaly: true,
    defaults: {
      warningThreshold: 2,
      criticalThreshold: 5,
      period: 600,
      evaluationPeriods: 5,
      statistic: 'Average',
      dataPointsToAlarm: 5,
      comparisonOperator: 'GreaterThanUpperThreshold',
      missingDataTreatment: 'ignore',
    },
  },

  // 3) DBLoad - Anomaly Only
  {
    tagKey: 'dbload-anomaly',
    metricName: 'DBLoad',
    metricNamespace: 'AWS/RDS',
    defaultCreate: true,
    anomaly: true,
    defaults: {
      warningThreshold: 2,
      criticalThreshold: 5,
      period: 300,
      evaluationPeriods: 1,
      statistic: 'Maximum',
      dataPointsToAlarm: 1,
      comparisonOperator: 'GreaterThanUpperThreshold',
      missingDataTreatment: 'ignore',
    },
  },

  // 4) Deadlocks - Static
  {
    tagKey: 'deadlocks',
    metricName: 'Deadlocks',
    metricNamespace: 'AWS/RDS',
    defaultCreate: true,
    anomaly: false,
    defaults: {
      warningThreshold: 0,
      criticalThreshold: 0,
      period: 120,
      evaluationPeriods: 1,
      statistic: 'Sum',
      dataPointsToAlarm: 1,
      comparisonOperator: 'GreaterThanThreshold',
      missingDataTreatment: 'ignore',
    },
  },

  // 5) FreeableMemory - Static Only
  {
    tagKey: 'freeable-memory',
    metricName: 'FreeableMemory',
    metricNamespace: 'AWS/RDS',
    defaultCreate: true,
    anomaly: false,
    defaults: {
      warningThreshold: 2000000000,
      criticalThreshold: 100000000,
      period: 120,
      evaluationPeriods: 2,
      statistic: 'Maximum',
      dataPointsToAlarm: 2,
      comparisonOperator: 'LessThanThreshold',
      missingDataTreatment: 'ignore',
    },
  },

  // 7) ReplicaLag - Static + Anomaly
  {
    tagKey: 'replica-lag',
    metricName: 'ReplicaLag',
    metricNamespace: 'AWS/RDS',
    defaultCreate: true,
    anomaly: false,
    defaults: {
      warningThreshold: 60,
      criticalThreshold: 300,
      period: 120,
      evaluationPeriods: 1,
      statistic: 'Maximum',
      dataPointsToAlarm: 1,
      comparisonOperator: 'GreaterThanThreshold',
      missingDataTreatment: 'ignore',
    },
  },
  {
    tagKey: 'replica-lag-anomaly',
    metricName: 'ReplicaLag',
    metricNamespace: 'AWS/RDS',
    defaultCreate: true,
    anomaly: true,
    defaults: {
      warningThreshold: 2,
      criticalThreshold: 5,
      period: 120,
      evaluationPeriods: 1,
      statistic: 'Average',
      dataPointsToAlarm: 1,
      comparisonOperator: 'GreaterThanUpperThreshold',
      missingDataTreatment: 'ignore',
    },
  },

  // 8) SwapUsage - Anomaly Only
  {
    tagKey: 'swap-usage-anomaly',
    metricName: 'SwapUsage',
    metricNamespace: 'AWS/RDS',
    defaultCreate: true,
    anomaly: true,
    defaults: {
      warningThreshold: 2,
      criticalThreshold: 5,
      period: 120,
      evaluationPeriods: 1,
      statistic: 'Maximum',
      dataPointsToAlarm: 1,
      comparisonOperator: 'GreaterThanUpperThreshold',
      missingDataTreatment: 'ignore',
    },
  },

  // 9) WriteLatency - Anomaly

  {
    tagKey: 'write-latency-anomaly',
    metricName: 'WriteLatency',
    metricNamespace: 'AWS/RDS',
    defaultCreate: true,
    anomaly: true,
    defaults: {
      warningThreshold: 5,
      criticalThreshold: 9,
      period: 300,
      evaluationPeriods: 2,
      statistic: 'Average',
      dataPointsToAlarm: 2,
      comparisonOperator: 'GreaterThanUpperThreshold',
      missingDataTreatment: 'ignore',
    },
  },
  // add more as needed
] as const;
