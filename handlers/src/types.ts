export interface AlarmProps {
  threshold: number;
  period: number;
  evaluationPeriods: number;
}

export interface Tag {
  [key: string]: string;
}
