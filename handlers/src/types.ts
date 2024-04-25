export interface AlarmProps {
  threshold: number;
  period: number;
  evaluationPeriods: number;
  metricName: string;
  namespace: string;
  dimensions: {Name: string; Value: string}[];
}

export interface RDSInstanceDetails {
  dbInstanceIdentifier: string;
  dbInstanceClass: string;
  engine: string;
  dbInstanceStatus: string;
  allocatedStorage: number;
}

export interface Tag {
  [key: string]: string;
}
