import {SQSBatchItemFailure, SQSRecord} from 'aws-lambda';
import {Rule} from 'aws-cdk-lib/aws-events';
import {EventPatterns} from "./enums.mjs";

// Type definitions for autoalarm

export type ValidEC2States =
  | 'running'
  //| 'pending'
  //| 'stopped'
  //| 'stopping'
  //| 'shutting-down'
  | 'terminated';

export type TagArray = {[key: string]: string}[];

export interface EC2AlarmManagerObject {
  instanceID: string;
  tags: Tag;
  state: ValidEC2States;
  ec2Metadata?: {platform: string | null; privateIP: string | null};
}

export interface Tag {
  [key: string]: string;
}

export type EC2AlarmManagerArray = EC2AlarmManagerObject[];

export interface Dimension {
  Name: string;
  Value: string;
}

//This is a type that is used to define the contents of event bridge rules in service-eventbridge-construct.ts
export type RuleObject = {
  [ruleName: string]: Rule;
};

/**
 * ServiceType is a mapped type that matches the keys of the EventPatterns enum to their string values.
 * This allows us to use the enum keys as types in the ProcessorFactory and other places where service type iteration
 * is needed.
 */
export type ServiceType = keyof typeof EventPatterns;

// This type is used to define the matching pattern for a service type from the EventPatterns Enum
export type ServiceTypePattern = {
  [K in keyof typeof EventPatterns]: typeof EventPatterns[K];
};

// This interface is used to define the structure of the service processors map in the ProcessorFactory on line 23 of processor-factory.mts
export type ServiceProcessorMap = {
  serviceEventPattern: ServiceTypePattern; // The service type pattern used to match the ARN in the SQS record
  serviceProcessor: (records: SQSRecord[]) => Promise<SQSFailureResponse>; // The actual processor function for handling records of this service type
};


export type SQSFailureResponse = {
  batchItemFailures: SQSBatchItemFailure[];
  batchItemBodies: SQSRecord[];
};


export interface PathMetrics {
  [path: string]: Dimension[];
}

//for prometheus rule groups in NameSpaces
export interface RuleGroup {
  name: string;
  rules: PrometheusRule[];
}

//for prometheus rules in rule groups
export interface PrometheusRule {
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

//Prometheus Alarm Config

export interface PrometheusAlarmConfig {
  instanceId: string; // ID of the instance
  type: string; // The type or classification of the alarm
  alarmName: string; // The name of the alarm
  alarmQuery: string; // The query used for the alarm
  duration: string; // The duration of the alarm, in "Xm" format
  severityType: string; // The severity of the alarm
}

export type PrometheusAlarmConfigArray = PrometheusAlarmConfig[];

//for prometheus namespace details when populating the rule groups
export interface NamespaceDetails {
  groups: RuleGroup[];
}

export type LoadBalancerIdentifiers = {
  LBType: 'app' | 'net' | null;
  LBName: string | null;
};

export interface AnomalyAlarmProps {
  evaluationPeriods: number;
  period: number;
  extendedStatistic: string;
}
