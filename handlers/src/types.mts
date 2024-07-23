import * as AWS from 'aws-sdk';

export interface AlarmConfig {
  metricName: string;
  namespace: string;
  threshold: number;
  comparisonOperator: string;
  evaluationPeriods: number;
  period: number;
  statistic: string;
  alarmDescription: string;
  dimensions: AWS.CloudWatch.Dimension[];
  alarmActions: string[];
  okActions?: string[];
  insufficientDataActions?: string[];
}
export type TagMap = {[key: string]: string};

export interface AlarmProps {
  threshold: number;
  period: number;
  evaluationPeriods: number;
  metricName: string;
  namespace: string;
  dimensions: {Name: string; Value: string}[];
}

export interface Tag {
  [key: string]: string;
}

export interface Dimension {
  Name: string;
  Value: string;
}

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

//for prometheus namespace details when populating the rule groups
export interface NamespaceDetails {
  groups: RuleGroup[];
}
