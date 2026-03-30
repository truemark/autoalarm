/**
 * Enriched alarm event payload schema (v1.0).
 * Published to SNS by the enrichment Lambda after gathering context
 * from CloudWatch, CloudTrail, OAM, and optionally AgentCore.
 */

export interface EnrichedAlarmEvent {
  /** Schema version for forward compatibility */
  version: '1.0';

  /** Alarm identity and state */
  alarm: AlarmInfo;

  /** Resource that triggered the alarm */
  resource: ResourceInfo;

  /** Enrichment context gathered by deterministic pipeline */
  context: EnrichmentContext;

  /** Deep links to consoles, dashboards, and tools */
  links: DeepLinks;

  /** Metadata about the enrichment process itself */
  enrichment: EnrichmentMetadata;

  /** Agent-generated analysis (present when agent invoked or fallback used) */
  agentSummary?: AgentSummary;
}

export interface AlarmInfo {
  name: string;
  arn: string;
  state: 'ALARM';
  previousState: 'OK' | 'INSUFFICIENT_DATA';
  reason: string;
  timestamp: string;
  severity: 'Critical' | 'Warning';
  metric: string;
  namespace: string;
  alarmType: 'static' | 'anomaly';
  threshold: number | null;
  currentValue: number | null;
}

export interface ResourceInfo {
  service: string;
  identifier: string;
  account: string;
  region: string;
  tags: Record<string, string>;
  owner: string | null;
  environment: string | null;
  application: string | null;
}

export interface EnrichmentContext {
  correlatedMetrics: CorrelatedMetric[];
  recentErrors: RecentError[] | null;
  recentDeployments: RecentDeployment[];
  runbookUrl: string | null;
}

export interface CorrelatedMetric {
  name: string;
  namespace: string;
  values: number[];
  trend: 'rising' | 'falling' | 'stable';
  current: number;
  link: string;
}

export interface RecentError {
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface RecentDeployment {
  eventName: string;
  timestamp: string;
  username: string;
  sourceIPAddress: string;
  link: string;
}

export interface DeepLinks {
  alarmConsole: string;
  metricsGraph: string;
  logsInsights: string | null;
  dashboard: string | null;
  runbook: string | null;
  cloudTrail: string;
}

export interface EnrichmentMetadata {
  timestamp: string;
  version: string;
  idempotencyKey: string;
  durationMs: number;
  logsSkipped: boolean;
  logsSkipReason?: 'timeout' | 'no_log_group' | 'error' | 'disabled';
  agentInvoked: boolean;
  agentSkipReason?:
    | 'severity_filtered'
    | 'rate_limited'
    | 'disabled'
    | 'timeout'
    | 'error';
  correlationWindow?: {
    concurrentAlarms: number;
    relatedAlarmNames: string[];
  };
}

export interface AgentSummary {
  summary: string;
  rootCauseHypothesis: string;
  recommendedActions: string[];
  confidence: 'high' | 'medium' | 'low';
  source: 'agent' | 'fallback';
}

/**
 * Parsed alarm identity extracted from the AutoAlarm naming convention:
 * AutoAlarm-{SERVICE}-{IDENTIFIER}-{METRIC}-[STORAGEPATH]-{TYPE}-{CLASSIFICATION}
 */
export interface ParsedAlarmIdentity {
  service: string;
  identifier: string;
  metric: string;
  storagePath?: string;
  alarmType: 'static' | 'anomaly';
  severity: 'Critical' | 'Warning';
}

/**
 * Map of service → correlated metrics to query when an alarm fires.
 */
export type CorrelatedMetricsMap = Record<
  string,
  Record<string, {namespace: string; metrics: string[]}>
>;

/**
 * SNS message attributes for subscriber-side filtering.
 */
export interface EnrichmentMessageAttributes {
  schemaVersion: string;
  severity: string;
  service: string;
  sourceAccount: string;
  region: string;
  environment?: string;
  owner?: string;
  hasAgentSummary: string;
  isDegraded: string;
}
