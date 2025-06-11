import {TagsObject} from './module-types.mjs';

export interface PrometheusAlarmConfig {
  instanceId: string; // ID of the instance
  type: string; // The type or classification of the alarm
  alarmName: string; // The name of the alarm
  alarmQuery: string; // The query used for the alarm
  duration: string; // The duration of the alarm, in "Xm" format
  severityType: string; // The severity of the alarm
}

//for prometheus rules in rule groups
export interface AMPRule {
  alert: string;
  expr: string;
  for?: string;
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

//for prometheus namespace details when populating the rule groups
export interface NamespaceDetails<N = string> {
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
    ruleGroup: RuleGroup<E> | undefined;
}

export interface PromUpdatesMap extends Map<string, MassPromUpdatesObject> {}
