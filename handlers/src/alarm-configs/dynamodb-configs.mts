/**
 * @fileoverview DynamoDB alarm configuration definitions.
 *
 * This file contains the default configurations for all supported DynamoDB CloudWatch alarms managed by AutoAlarm.
 *
 * @requires
 * - Approval from Owners Team lead and consultation before adding new alarms
 * - Anomaly Alarms can only use the following comparison operators:
 *     GreaterThanUpperThreshold,
 *     LessThanLowerOrGreaterThanUpperThreshold,
 *     LessThanLowerThreshold
 *
 * @Owners HARMONY-DEVOPS
 */

import {MetricAlarmConfig} from '../types/index.mjs';
import {ComparisonOperator} from '@aws-sdk/client-cloudwatch';
import {TreatMissingData} from 'aws-cdk-lib/aws-cloudwatch';

/**
 * DynamoDB alarm configuration definitions.
 * Implements the {@link MetricAlarmConfig} interface.
 * Used to map a tag key to a CloudWatch metric name and namespace and default alarm configurations.
 *
 * Tag usage on a DynamoDB Table:
 *   autoalarm:dynamodb-successful-request-latency
 *   autoalarm:dynamodb-throttled-requests
 *   autoalarm:dynamodb-system-errors
 *   autoalarm:dynamodb-conditional-check-failed-requests
 */
export const DYNAMODB_CONFIGS: MetricAlarmConfig[] = [
  /**
   * SuccessfulRequestLatency
   * Threshold-based alarm for latency spikes.
   */
  {
    tagKey: 'successful-request-latency',
    metricName: 'SuccessfulRequestLatency',
    metricNamespace: 'AWS/DynamoDB',
    defaultCreate: true,
    anomaly: false,
    defaults: {
      warningThreshold: 100, // ms, warning on >100ms average
      criticalThreshold: 200, // ms
      period: 60,
      evaluationPeriods: 5,
      statistic: 'Average',
      dataPointsToAlarm: 3,
      comparisonOperator: ComparisonOperator.GreaterThanThreshold,
      missingDataTreatment: TreatMissingData.IGNORE,
    },
  },

  /**
   * ThrottledRequests
   * Threshold-based alarm on throttling.
   */
  {
    tagKey: 'throttled-requests',
    metricName: 'ThrottledRequests',
    metricNamespace: 'AWS/DynamoDB',
    defaultCreate: true,
    anomaly: false,
    defaults: {
      warningThreshold: 1, // any throttling triggers warning
      criticalThreshold: 5,
      period: 60,
      evaluationPeriods: 5,
      statistic: 'Sum',
      dataPointsToAlarm: 1,
      comparisonOperator: ComparisonOperator.GreaterThanThreshold,
      missingDataTreatment: TreatMissingData.IGNORE,
    },
  },

  /**
   * SystemErrors
   * Threshold-based alarm for internal DynamoDB errors.
   */
  {
    tagKey: 'system-errors',
    metricName: 'SystemErrors',
    metricNamespace: 'AWS/DynamoDB',
    defaultCreate: true,
    anomaly: false,
    defaults: {
      warningThreshold: 1, // any system errors should alert
      criticalThreshold: 5,
      period: 60,
      evaluationPeriods: 5,
      statistic: 'Sum',
      dataPointsToAlarm: 1,
      comparisonOperator: ComparisonOperator.GreaterThanThreshold,
      missingDataTreatment: TreatMissingData.IGNORE,
    },
  },

  /**
   * ConditionalCheckFailedRequests
   * Often application-driven → opt-in only.
   */
  {
    tagKey: 'conditional-check-failed-requests',
    metricName: 'ConditionalCheckFailedRequests',
    metricNamespace: 'AWS/DynamoDB',
    defaultCreate: false, // opt-in to avoid noise
    anomaly: false,
    defaults: {
      warningThreshold: 10,
      criticalThreshold: 50,
      period: 60,
      evaluationPeriods: 5,
      statistic: 'Sum',
      dataPointsToAlarm: 3,
      comparisonOperator: ComparisonOperator.GreaterThanThreshold,
      missingDataTreatment: TreatMissingData.IGNORE,
    },
  },
] as const;
