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

import {MetricAlarmConfig} from '../types/index.mjs';
import {ComparisonOperator} from '@aws-sdk/client-cloudwatch';
import {TreatMissingData} from 'aws-cdk-lib/aws-cloudwatch';

/**
 * _RDS_CLUSTER alarm configuration definitions.
 * Implements the {@link MetricAlarmConfig} interface.
 * Used to map a tag key to a CloudWatch metric name and namespace to default alarm configurations {@link MetricAlarmOptions}.
 */
export const RDS_CLUSTER_CONFIGS: MetricAlarmConfig[] = [
  // 1) DatabaseConnections - Anomaly
  {
    tagKey: 'db-connections-anomaly',
    metricName: 'DatabaseConnections',
    metricNamespace: 'AWS/RDS',
    defaultCreate: true,
    anomaly: true,
    defaults: {
      warningThreshold: 2,
      criticalThreshold: 4,
      period: 60,
      evaluationPeriods: 15,
      statistic: 'Maximum',
      dataPointsToAlarm: 12,
      comparisonOperator: ComparisonOperator.GreaterThanUpperThreshold,
      missingDataTreatment: TreatMissingData.IGNORE,
    },
  },

  // 2) ReplicaLag - Static
  {
    tagKey: 'replica-lag',
    metricName: 'ReplicaLag',
    metricNamespace: 'AWS/RDS',
    defaultCreate: false,
    anomaly: false,
    defaults: {
      warningThreshold: 30,
      criticalThreshold: 600,
      period: 60,
      evaluationPeriods: 15,
      statistic: 'Maximum',
      dataPointsToAlarm: 12,
      comparisonOperator: 'GreaterThanThreshold',
      missingDataTreatment: 'ignore',
    },
  },

  // 3) ReplicaLag - Anomaly
  {
    tagKey: 'replica-lag-anomaly',
    metricName: 'ReplicaLag',
    metricNamespace: 'AWS/RDS',
    defaultCreate: true,
    anomaly: true,
    defaults: {
      warningThreshold: 2,
      criticalThreshold: 4,
      period: 60,
      evaluationPeriods: 20,
      statistic: 'Maximum',
      dataPointsToAlarm: 16,
      comparisonOperator: 'GreaterThanUpperThreshold',
      missingDataTreatment: 'ignore',
    },
  },

  // 4) FailoverState - Static
  {
    tagKey: 'failover-state',
    metricName: 'FailoverState',
    metricNamespace: 'AWS/RDS',
    defaultCreate: false,
    anomaly: false,
    defaults: {
      warningThreshold: 0,
      criticalThreshold: 1,
      period: 60,
      evaluationPeriods: 1,
      statistic: 'Maximum',
      dataPointsToAlarm: 1,
      comparisonOperator: 'GreaterThanThreshold',
      missingDataTreatment: 'notBreaching',
    },
  },
  // add more as needed
] as const;
