import {Statistic} from '@aws-sdk/client-cloudwatch';

export interface AlarmProps {
  threshold: number;
  period: number;
  evaluationPeriods: number;
  metricName: string;
  namespace: string;
  dimensions: {Name: string; Value: string}[];
  statistic?: Statistic; // Optional property for standard statistics
  extendedStatistic?: string; // Optional property for extended statistics
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

export interface AnomalyAlarmProps {
  evaluationPeriods: number;
  period: number;
  extendedStatistic: string;
}
