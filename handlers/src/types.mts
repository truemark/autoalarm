import {SQSBatchItemFailure, SQSRecord} from 'aws-lambda';

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

// Todo: We will change any once we unify the modules into a consolidated master module
// type for dynamically managing alarms in main handler:
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AsyncAlarmManager = (records: SQSRecord | any) => Promise<any>;

export type ServiceType =
  | 'alb'
  | 'cloudfront'
  | 'ec2'
  | 'opensearch'
  | 'rds'
  | 'rds-cluster'
  | 'route53-resolver'
  | 'sqs'
  | 'step-function'
  | 'targetgroup'
  | 'transit-gateway'
  | 'vpn';

export interface ServiceProps {
  service: ServiceType;
  identifiers: string[];
  handler: AsyncAlarmManager;
}

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
  rules: Rule[];
}

//for prometheus rules in rule groups
export interface Rule {
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
