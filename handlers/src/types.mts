// Type definitions for autoalarm

export interface EC2AlarmManagerObject {
  instanceID: string;
  tags: Tag;
  state: string;
  ec2Metadata?: {platform: string | null, privateIP: string | null} ;
}

export interface Tag {
  [key: string]: string;
}

export type EC2AlarmManagerArray = EC2AlarmManagerObject[];

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

export type PrometheusAlarmConfigArray = Rule[];

//for prometheus namespace details when populating the rule groups
export interface NamespaceDetails {
  groups: RuleGroup[];
}

export interface AnomalyAlarmProps {
  evaluationPeriods: number;
  period: number;
  extendedStatistic: string;
}
