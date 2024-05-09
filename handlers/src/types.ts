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
