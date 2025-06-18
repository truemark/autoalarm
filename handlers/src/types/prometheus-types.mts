import {MetricAlarmConfig, TagV2} from './index.mjs';

/**
 * This is old logic that is used for prometheus alarm config storage in Ec2 Modules.
 */
export interface PrometheusAlarmConfig {
  instanceId: string; // ID of the instance
  type: string; // The type or classification of the alarm
  alarmName: string; // The name of the alarm
  alarmQuery: string; // The query used for the alarm
  duration: string; // The duration of the alarm, in "Xm" format
  severityType: string; // The severity of the alarm
}

/**
 * Represents a single Prometheus rule for an alarm.
 * @property {string} alertName - The name of the alert.
 * @property {string} expr - The Prometheus expression/query for the rule.
 * @property {string} [timeSeries] - Optional time series identifier.
 * @property {Object} [labels] - Optional labels for the alert.
 * @property {string} labels.severity - The severity level of the alert.
 * @property {Object} [annotations] - Optional annotations for the alert.
 * @property {string} annotations.summary - A summary of the alert.
 * @property {string} annotations.description - A description of the alert.
 * @property {Object} [annotations] - Additional annotations for the alert.
 */
export interface AMPRule {
  alertName: string;
  expr: string;
  timeSeries?: string;
  labels?: {
    severity: string;
    [key: string]: string; // Use as needed
  };
  annotations?: {
    summary: string;
    description: string;
    [key: string]: string; // Use as needed
  };
}

/**
 * Represents a group of Prometheus rules.
 * @template N - by default is undefined, but can be used to specify a rule
 * group name type for different services later defined here in this type file.
 */
export interface RuleGroup<N = string> {
  name: N;
  rules: AMPRule[];
}

export type PrometheusAlarmConfigArray = PrometheusAlarmConfig[];

// Interface to correlate namespace with its configs (groups and rules
export interface NameSpaceDetails {
  [namespace: string]: NamespaceConfig;
}

//for prometheus namespace details when populating the rule groups
export interface NamespaceConfig<N = string> {
  groups: RuleGroup<N>[];
}

/**
 * Represents a mapping of namespace details for Prometheus configurations.
 * key: namespace name or the engine name (e.g., 'ORACLE', 'MYSQL', 'POSTGRES')
 * Provides fast lookup without more tedious object traversal.
 */
export interface NamespaceDetailsMap extends Map<string, NamespaceConfig> {}

/**
 * Represents the database engine type for Prometheus logic
 */
export type DbEngine = 'ORACLE' | 'MYSQL' | 'POSTGRES';

/**
 * Represents a mapping of Prometheus event sorting values for each engine (used as a namespace).
 * flexibility in specifying different engines across different services for strong typing.
 * Object properties are loose here to account for building the map over execution time.
 * TODO: this should be used with Cloudwatch as well for all services
 */
export interface PromHostInfoMap
  extends Map<
    string,
    {
      host?: string;
      isDisabled?: boolean;
      tags?: TagV2[];
      configs?: MetricAlarmConfig[];
      ampRules?: AMPRule[];
    }
  > {}

/**
 * Represents a mapping of mass Prometheus updates.
 * @template E - The type of the service engine/s, default is string. This allows
 * flexibility in specifying different engines across different services.
 * Map<E - engine, Map<string - arn,  {hostID: string; isDisabled: boolean; tags: Tag[], ampRule?: AMPRule}>>
 * TODO: This should be used with CloudWatch as well for all services
 */
export interface PromUpdateMap<E extends string = string>
  extends Map<E, PromHostInfoMap> {}

/**
 * Interface for return value when comparing PromUpdateMap to NamespaceDetailsMap
 */

interface CompareResult {
  addedRules: Array<{ namespace: string; rules: AMPRule[] }>;
  removedRules: Array<{ namespace: string; rules: AMPRule[] }>;
  updatedNamespaceDetailsMap: NamespaceDetailsMap;
  dynamoRecordsUpdate: PromUpdateMap;
}
