import {TagsObject} from './module-types.mjs';

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
    [key: string]: string;
  };
  annotations?: {
    summary: string;
    description: string;
    [key: string]: string;
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
export interface NameSpaceDetails{
  namespace: string;
  details: NamespaceConfig;
}

//for prometheus namespace details when populating the rule groups
export interface NamespaceConfig<N = string> {
  groups: RuleGroup<N>[];
}

/**
 * Represents the database engine type for Prometheus logic
 */
export type DbEngine = 'ORACLE' | 'MYSQL' | 'POSTGRES';

/**
 * Represents a mapping of mass Prometheus updates.
 * @template E - The type of the service engine/s, default is string. This allows
 * flexibility in specifying different engines across different services.
 */
export interface MassPromUpdatesObject<E = string> {
    engine: E | undefined;
    hostID: string | undefined;
    isDisabled: boolean;
    tags: TagsObject;
}

/**
 * Represents a map of Prometheus updates, where the key is the arn or identifier
 * and the value is a {@link MassPromUpdatesObject} interface.
 */
export interface PromUpdatesMap extends Map<string, MassPromUpdatesObject> {}
