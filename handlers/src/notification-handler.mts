import {EventBridgeEvent} from 'aws-lambda';
import {SSMClient, GetParameterCommand} from '@aws-sdk/client-ssm';
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  GetMetricDataCommand,
  ListTagsForResourceCommand,
  StateValue,
} from '@aws-sdk/client-cloudwatch';
import {
  CloudTrailClient,
  LookupEventsCommand,
} from '@aws-sdk/client-cloudtrail';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import * as logging from '@nr1e/logging';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AlarmState {
  value: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
  reason: string;
  reasonData?: string;
  timestamp: string;
}

interface MetricStatConfig {
  metric: {
    namespace: string;
    name: string;
    dimensions: Record<string, string>;
  };
  period: number;
  stat: string;
}

interface MetricConfig {
  id: string;
  metricStat?: MetricStatConfig;
  expression?: string;
  returnData: boolean;
}

interface AlarmStateChangeDetail {
  alarmName: string;
  state: AlarmState;
  previousState: AlarmState;
  configuration: {
    metrics?: MetricConfig[];
    description?: string;
  };
}

type AlarmStateChangeEvent = EventBridgeEvent<
  'CloudWatch Alarm State Change',
  AlarmStateChangeDetail
>;

interface ParsedAlarmInfo {
  service: string;
  identifier: string;
  metricName: string;
  classification: string;
  isAnomaly: boolean;
}

interface CorrelatedMetricResult {
  name: string;
  current: number;
  trend: 'rising' | 'falling' | 'stable';
}

interface EnrichmentContext {
  owner: string | null;
  environment: string | null;
  application: string | null;
  relatedAlarms: Array<{name: string; metric: string}>;
  triggeringMetricTrend: Array<{timestamp: Date; value: number}>;
  correlatedMetrics: CorrelatedMetricResult[];
  threshold: number | null;
  recentChanges: Array<{event: string; time: Date; user: string}>;
  runbookUrl: string | null;
}

interface SlackBlock {
  type: string;
  text?: {type: string; text: string; emoji?: boolean};
  fields?: Array<{type: string; text: string}>;
  elements?: Array<{
    type: string;
    text?: {type: string; text: string; emoji?: boolean};
    url?: string;
  }>;
}

interface SlackMessage {
  attachments: Array<{
    color: string;
    blocks: SlackBlock[];
  }>;
}

// ─── Service-Specific Mappings ───────────────────────────────────────────────

// Correlated metrics: when metric X fires, also query metrics Y and Z
const CORRELATED_METRICS: Record<
  string,
  Record<string, {namespace: string; metrics: string[]}>
> = {
  EC2: {
    CPUUtilization: {
      namespace: 'AWS/EC2',
      metrics: ['NetworkIn', 'NetworkOut', 'StatusCheckFailed'],
    },
    StatusCheckFailed: {
      namespace: 'AWS/EC2',
      metrics: ['CPUUtilization', 'NetworkIn', 'NetworkOut'],
    },
  },
  RDS: {
    CPUUtilization: {
      namespace: 'AWS/RDS',
      metrics: [
        'DatabaseConnections',
        'FreeableMemory',
        'DiskQueueDepth',
        'ReadLatency',
        'WriteLatency',
      ],
    },
    FreeableMemory: {
      namespace: 'AWS/RDS',
      metrics: ['CPUUtilization', 'DatabaseConnections', 'SwapUsage'],
    },
    DatabaseConnections: {
      namespace: 'AWS/RDS',
      metrics: ['CPUUtilization', 'FreeableMemory'],
    },
  },
  ALB: {
    TargetResponseTime: {
      namespace: 'AWS/ApplicationELB',
      metrics: [
        'HTTPCode_Target_5XX_Count',
        'ActiveConnectionCount',
        'RequestCount',
        'HealthyHostCount',
      ],
    },
    HTTPCode_Target_5XX_Count: {
      namespace: 'AWS/ApplicationELB',
      metrics: ['TargetResponseTime', 'UnHealthyHostCount', 'RequestCount'],
    },
  },
  SQS: {
    ApproximateAgeOfOldestMessage: {
      namespace: 'AWS/SQS',
      metrics: [
        'ApproximateNumberOfMessagesVisible',
        'NumberOfMessagesSent',
        'NumberOfMessagesReceived',
      ],
    },
  },
  OPENSEARCH: {
    'ClusterStatus.red': {
      namespace: 'AWS/ES',
      metrics: [
        'FreeStorageSpace',
        'CPUUtilization',
        'JVMMemoryPressure',
        'Nodes',
      ],
    },
  },
  ECS: {
    CPUUtilization: {
      namespace: 'AWS/ECS',
      metrics: ['MemoryUtilization', 'RunningTaskCount', 'DesiredTaskCount'],
    },
  },
  CLOUDFRONT: {
    '5xxErrorRate': {
      namespace: 'AWS/CloudFront',
      metrics: ['4xxErrorRate', 'Requests', 'BytesDownloaded'],
    },
  },
  SFN: {
    ExecutionsFailed: {
      namespace: 'AWS/States',
      metrics: ['ExecutionsStarted', 'ExecutionsTimedOut', 'ExecutionThrottled'],
    },
  },
};

// CloudTrail event names to filter by service — only show deployment-related events
const DEPLOYMENT_EVENTS: Record<string, string[]> = {
  EC2: ['RunInstances', 'StopInstances', 'TerminateInstances'],
  RDS: ['ModifyDBInstance', 'RebootDBInstance', 'ModifyDBCluster'],
  ALB: ['ModifyLoadBalancerAttributes', 'ModifyTargetGroup'],
  ECS: ['UpdateService', 'RegisterTaskDefinition'],
  SFN: ['UpdateStateMachine'],
  OPENSEARCH: ['UpdateDomainConfig'],
};

// Map service names to their CloudWatch dimension key
const DIMENSION_MAP: Record<string, string> = {
  EC2: 'InstanceId',
  RDS: 'DBInstanceIdentifier',
  ALB: 'LoadBalancer',
  SQS: 'QueueName',
  OPENSEARCH: 'DomainName',
  ECS: 'ServiceName',
  CLOUDFRONT: 'DistributionId',
  SFN: 'StateMachineArn',
  TARGETGROUP: 'TargetGroup',
  TRANSITGATEWAY: 'TransitGateway',
  VPN: 'VpnId',
  ROUTE53RESOLVER: 'EndpointId',
};

// ─── Initialization ──────────────────────────────────────────────────────────

const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'notification-handler',
  level,
});

const region = process.env.AWS_REGION || '';
const runbookBaseUrl = process.env.RUNBOOK_URL || '';
const retryStrategy = new ConfiguredRetryStrategy(3);
const ssmClient = new SSMClient({region});
const cloudWatchClient = new CloudWatchClient({region, retryStrategy});
const cloudTrailClient = new CloudTrailClient({region, retryStrategy});
let cachedWebhookUrl: string | undefined;
let cachedRunbookAnchors: string[] | undefined;

// ─── SSM ─────────────────────────────────────────────────────────────────────

async function getWebhookUrl(): Promise<string> {
  if (cachedWebhookUrl) return cachedWebhookUrl;

  const paramName = process.env.SLACK_WEBHOOK_SSM_PATH;
  if (!paramName) {
    throw new Error('SLACK_WEBHOOK_SSM_PATH environment variable not set');
  }

  const response = await ssmClient.send(
    new GetParameterCommand({Name: paramName, WithDecryption: true}),
  );

  const value = response.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter ${paramName} not found or empty`);
  }

  cachedWebhookUrl = value;
  return value;
}

// ─── Alarm Name Parsing ──────────────────────────────────────────────────────

function parseAlarmName(
  alarmName: string,
  metricName?: string,
): ParsedAlarmInfo {
  const stripped = alarmName.replace(/^AutoAlarm-/, '');
  const parts = stripped.split('-');

  const classification = parts[parts.length - 1];
  const isAnomaly = parts[parts.length - 2] === 'anomaly';
  const service = parts[0];

  if (metricName) {
    const metricIndex = parts.indexOf(metricName, 1);
    if (metricIndex > 1) {
      const identifier = parts.slice(1, metricIndex).join('-');
      return {service, identifier, metricName, classification, isAnomaly};
    }
  }

  const endIndex = isAnomaly ? parts.length - 2 : parts.length - 1;
  const fallbackMetric = parts[endIndex - 1] || 'Unknown';
  const identifier = parts.slice(1, endIndex - 1).join('-') || 'Unknown';

  return {
    service,
    identifier,
    metricName: metricName || fallbackMetric,
    classification,
    isAnomaly,
  };
}

// ─── Ownership Resolution ────────────────────────────────────────────────────

function resolveOwnership(tags: Record<string, string>): {
  owner: string | null;
  environment: string | null;
  application: string | null;
} {
  const find = (...keys: string[]): string | null => {
    for (const key of keys) {
      const match = Object.entries(tags).find(
        ([k]) => k.toLowerCase() === key.toLowerCase(),
      );
      if (match) return match[1];
    }
    return null;
  };

  return {
    owner: find('owner', 'team', 'autoalarm:owner'),
    environment: find('environment', 'env', 'autoalarm:environment'),
    application: find('application', 'app', 'autoalarm:application'),
  };
}

// ─── Enrichment Functions ────────────────────────────────────────────────────

async function fetchAlarmTags(
  alarmArn: string,
): Promise<Record<string, string>> {
  try {
    const response = await cloudWatchClient.send(
      new ListTagsForResourceCommand({ResourceARN: alarmArn}),
    );
    const tags: Record<string, string> = {};
    for (const tag of response.Tags || []) {
      if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
    }
    return tags;
  } catch (error) {
    log
      .warn()
      .str('function', 'fetchAlarmTags')
      .str('error', String(error))
      .msg('Failed to fetch alarm tags');
    return {};
  }
}

async function fetchRelatedAlarms(
  service: string,
  identifier: string,
  currentAlarmName: string,
): Promise<Array<{name: string; metric: string}>> {
  try {
    const prefix = `AutoAlarm-${service}-${identifier}-`;
    const response = await cloudWatchClient.send(
      new DescribeAlarmsCommand({
        AlarmNamePrefix: prefix,
        StateValue: StateValue.ALARM,
        MaxRecords: 10,
      }),
    );

    return (response.MetricAlarms || [])
      .filter((a) => a.AlarmName && a.AlarmName !== currentAlarmName)
      .map((a) => ({
        name: a.AlarmName!,
        metric: a.MetricName || 'Unknown',
      }))
      .slice(0, 5);
  } catch (error) {
    log
      .warn()
      .str('function', 'fetchRelatedAlarms')
      .str('error', String(error))
      .msg('Failed to fetch related alarms');
    return [];
  }
}

function getDimensions(
  service: string,
  identifier: string,
): {Name: string; Value: string}[] {
  const dimName = DIMENSION_MAP[service] || 'ResourceId';
  return [{Name: dimName, Value: identifier}];
}

function computeTrend(values: number[]): 'rising' | 'falling' | 'stable' {
  if (values.length < 2) return 'stable';
  const first = values.slice(0, Math.ceil(values.length / 3));
  const last = values.slice(-Math.ceil(values.length / 3));
  const avgFirst = first.reduce((a, b) => a + b, 0) / first.length;
  const avgLast = last.reduce((a, b) => a + b, 0) / last.length;
  const threshold = avgFirst * 0.1 || 1;
  if (avgLast > avgFirst + threshold) return 'rising';
  if (avgLast < avgFirst - threshold) return 'falling';
  return 'stable';
}

async function fetchMetricTrend(
  metricStat: MetricStatConfig,
): Promise<{datapoints: Array<{timestamp: Date; value: number}>}> {
  try {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 60 * 60 * 1000);

    const response = await cloudWatchClient.send(
      new GetMetricDataCommand({
        MetricDataQueries: [
          {
            Id: 'm1',
            MetricStat: {
              Metric: {
                Namespace: metricStat.metric.namespace,
                MetricName: metricStat.metric.name,
                Dimensions: Object.entries(metricStat.metric.dimensions).map(
                  ([Name, Value]) => ({Name, Value}),
                ),
              },
              Period: 60,
              Stat: metricStat.stat,
            },
            ReturnData: true,
          },
        ],
        StartTime: startTime,
        EndTime: endTime,
      }),
    );

    const timestamps = response.MetricDataResults?.[0]?.Timestamps || [];
    const values = response.MetricDataResults?.[0]?.Values || [];

    const datapoints = timestamps
      .map((ts, i) => ({timestamp: ts, value: values[i]}))
      .filter(
        (dp): dp is {timestamp: Date; value: number} =>
          dp.timestamp !== undefined && dp.value !== undefined,
      )
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return {datapoints};
  } catch (error) {
    log
      .warn()
      .str('function', 'fetchMetricTrend')
      .str('error', String(error))
      .msg('Failed to fetch metric trend');
    return {datapoints: []};
  }
}

async function fetchCorrelatedMetrics(
  service: string,
  metricName: string,
  identifier: string,
): Promise<CorrelatedMetricResult[]> {
  const config = CORRELATED_METRICS[service]?.[metricName];
  if (!config) return [];

  const dimensions = getDimensions(service, identifier);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 30 * 60 * 1000);

  const queries = config.metrics.slice(0, 10).map((name, idx) => ({
    Id: `c${idx}`,
    MetricStat: {
      Metric: {
        Namespace: config.namespace,
        MetricName: name,
        Dimensions: dimensions,
      },
      Period: 60,
      Stat: 'Average',
    },
    ReturnData: true,
  }));

  try {
    const response = await cloudWatchClient.send(
      new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: startTime,
        EndTime: endTime,
      }),
    );

    return (response.MetricDataResults || [])
      .map((mdr, idx) => {
        const values = mdr.Values || [];
        return {
          name: config.metrics[idx],
          current: values.length > 0 ? values[values.length - 1] : 0,
          trend: computeTrend(values),
        };
      })
      .filter((m) => m.current !== 0 || m.trend !== 'stable');
  } catch (error) {
    log
      .warn()
      .str('function', 'fetchCorrelatedMetrics')
      .str('error', String(error))
      .msg('Failed to fetch correlated metrics');
    return [];
  }
}

async function fetchRecentChanges(
  service: string,
  identifier: string,
): Promise<Array<{event: string; time: Date; user: string}>> {
  const relevantEvents = DEPLOYMENT_EVENTS[service];

  try {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 2 * 60 * 60 * 1000);

    const response = await cloudTrailClient.send(
      new LookupEventsCommand({
        LookupAttributes: [
          {AttributeKey: 'ResourceName', AttributeValue: identifier},
        ],
        StartTime: startTime,
        EndTime: endTime,
        MaxResults: 10,
      }),
    );

    return (response.Events || [])
      .filter(
        (evt): evt is typeof evt & {EventName: string; EventTime: Date} =>
          evt.EventName !== undefined &&
          evt.EventTime !== undefined &&
          // If we have a service-specific filter, apply it; otherwise show all
          (!relevantEvents || relevantEvents.includes(evt.EventName!)),
      )
      .slice(0, 5)
      .map((evt) => ({
        event: evt.EventName,
        time: evt.EventTime,
        user: evt.Username || 'Unknown',
      }));
  } catch (error) {
    log
      .warn()
      .str('function', 'fetchRecentChanges')
      .str('error', String(error))
      .msg('Failed to fetch CloudTrail events');
    return [];
  }
}

// ─── Runbook Resolution ──────────────────────────────────────────────────────

function headingToAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchRunbookAnchors(): Promise<string[]> {
  if (cachedRunbookAnchors) return cachedRunbookAnchors;
  if (!runbookBaseUrl) return [];

  try {
    const wikiMatch = runbookBaseUrl.match(
      /github\.com\/([^/]+)\/([^/]+)\/wiki\/([^#]+)/,
    );
    if (!wikiMatch) {
      log
        .warn()
        .str('function', 'fetchRunbookAnchors')
        .msg('RUNBOOK_URL is not a recognized GitHub wiki URL, skipping fetch');
      return [];
    }

    const [, org, repo, page] = wikiMatch;
    const rawUrl = `https://raw.githubusercontent.com/wiki/${org}/${repo}/${page}.md`;

    const response = await fetch(rawUrl, {signal: AbortSignal.timeout(5000)});
    if (!response.ok) {
      log
        .warn()
        .str('function', 'fetchRunbookAnchors')
        .num('status', response.status)
        .msg('Failed to fetch runbook markdown');
      return [];
    }

    const markdown = await response.text();
    const headingPattern = /^#{1,6}\s+(.+)$/gm;
    const anchors: string[] = [];
    let match;
    while ((match = headingPattern.exec(markdown)) !== null) {
      anchors.push(headingToAnchor(match[1]));
    }

    cachedRunbookAnchors = anchors;
    log
      .info()
      .str('function', 'fetchRunbookAnchors')
      .num('anchorCount', anchors.length)
      .msg('Fetched runbook anchors');
    return anchors;
  } catch (error) {
    log
      .warn()
      .str('function', 'fetchRunbookAnchors')
      .str('error', String(error))
      .msg('Failed to fetch runbook anchors');
    return [];
  }
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function findBestRunbookAnchor(
  service: string,
  metricName: string,
  anchors: string[],
): string | null {
  if (anchors.length === 0) return null;

  const searchTokens = tokenize(`${service} ${metricName}`);

  let bestAnchor: string | null = null;
  let bestScore = 0;

  for (const anchor of anchors) {
    const anchorTokens = tokenize(anchor);
    let score = 0;
    for (const token of searchTokens) {
      if (anchorTokens.some((at) => at.includes(token) || token.includes(at))) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestAnchor = anchor;
    }
  }

  return bestScore >= 2 ? bestAnchor : null;
}

async function resolveRunbookUrl(
  service: string,
  metricName: string,
  tagOverride?: string,
): Promise<string | null> {
  if (tagOverride) return tagOverride;
  if (!runbookBaseUrl) return null;

  const anchors = await fetchRunbookAnchors();
  const anchor = findBestRunbookAnchor(service, metricName, anchors);

  if (anchor) {
    const baseWithoutHash = runbookBaseUrl.split('#')[0];
    return `${baseWithoutHash}#${anchor}`;
  }

  return runbookBaseUrl;
}

function parseThresholdFromReason(reasonData?: string): number | null {
  if (!reasonData) return null;
  try {
    const parsed = JSON.parse(reasonData);
    return typeof parsed.threshold === 'number' ? parsed.threshold : null;
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatValue(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (Number.isInteger(value)) return value.toString();
  if (value < 0.01) return value.toExponential(1);
  return value.toFixed(2);
}

function relativeTime(timestamp: Date): string {
  const diffMs = Date.now() - timestamp.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function trendEmoji(trend: 'rising' | 'falling' | 'stable'): string {
  if (trend === 'rising') return '\u2197\uFE0F';
  if (trend === 'falling') return '\u2198\uFE0F';
  return '\u2194\uFE0F';
}

function buildTrendSummary(
  datapoints: Array<{timestamp: Date; value: number}>,
  threshold: number | null,
): string {
  if (datapoints.length === 0) return 'No data available';

  const sampleSize = Math.min(5, datapoints.length);
  const step = Math.max(1, Math.floor(datapoints.length / sampleSize));
  const sampled: Array<{timestamp: Date; value: number}> = [];
  for (let i = 0; i < datapoints.length; i += step) {
    sampled.push(datapoints[i]);
  }
  const last = datapoints[datapoints.length - 1];
  if (sampled[sampled.length - 1] !== last) {
    sampled.push(last);
  }

  let trend = sampled.map((p) => formatValue(p.value)).join(' \u2192 ');

  if (threshold !== null) {
    trend += ` (threshold: ${formatValue(threshold)})`;
  }

  return trend;
}

function getAlarmColor(state: string, classification: string): string {
  if (state === 'OK') return '#28a745';
  if (classification === 'Critical') return '#dc3545';
  return '#ffc107';
}

function getConsoleUrl(alarmName: string, awsRegion: string): string {
  const encoded = encodeURIComponent(alarmName);
  return `https://${awsRegion}.console.aws.amazon.com/cloudwatch/home?region=${awsRegion}#alarmsV2:alarm/${encoded}`;
}

function getMetricsGraphUrl(
  awsRegion: string,
  namespace: string,
  metricName: string,
  dimensions: {Name: string; Value: string}[],
): string {
  const dimStr = dimensions
    .map((d) => `~'${d.Name}~'${d.Value}`)
    .join('');
  const ns = namespace.replace(/\//g, '*2f');
  return `https://${awsRegion}.console.aws.amazon.com/cloudwatch/home?region=${awsRegion}#metricsV2:graph=~(metrics~(~(~'${ns}~'${metricName}${dimStr}))~view~'timeSeries~region~'${awsRegion}~stat~'Average~period~60)`;
}

function getCloudTrailUrl(identifier: string, awsRegion: string): string {
  const encoded = encodeURIComponent(identifier);
  return `https://${awsRegion}.console.aws.amazon.com/cloudtrailv2/home?region=${awsRegion}#/events?ResourceName=${encoded}`;
}

function getResourceUrl(
  service: string,
  identifier: string,
  awsRegion: string,
): string | null {
  switch (service) {
    case 'EC2':
      return `https://${awsRegion}.console.aws.amazon.com/ec2/home?region=${awsRegion}#InstanceDetails:instanceId=${identifier}`;
    case 'RDS':
      return `https://${awsRegion}.console.aws.amazon.com/rds/home?region=${awsRegion}#database:id=${identifier};is-cluster=false`;
    case 'ALB':
      return `https://${awsRegion}.console.aws.amazon.com/ec2/home?region=${awsRegion}#LoadBalancers:search=${encodeURIComponent(identifier)}`;
    case 'SQS':
      return `https://${awsRegion}.console.aws.amazon.com/sqs/v3/home?region=${awsRegion}#/queues?query=${encodeURIComponent(identifier)}`;
    case 'OPENSEARCH':
      return `https://${awsRegion}.console.aws.amazon.com/aos/home?region=${awsRegion}#/opensearch/domains/${identifier}`;
    case 'ECS':
      return `https://${awsRegion}.console.aws.amazon.com/ecs/v2/clusters?region=${awsRegion}`;
    case 'CLOUDFRONT':
      return `https://us-east-1.console.aws.amazon.com/cloudfront/v4/home#/distributions/${identifier}`;
    case 'SFN':
      return `https://${awsRegion}.console.aws.amazon.com/states/home?region=${awsRegion}#/statemachines`;
    case 'TARGETGROUP':
      return `https://${awsRegion}.console.aws.amazon.com/ec2/home?region=${awsRegion}#TargetGroups:search=${encodeURIComponent(identifier)}`;
    case 'VPN':
      return `https://${awsRegion}.console.aws.amazon.com/vpcconsole/home?region=${awsRegion}#VpnConnections:vpnConnectionId=${identifier}`;
    case 'TRANSITGATEWAY':
      return `https://${awsRegion}.console.aws.amazon.com/vpcconsole/home?region=${awsRegion}#TransitGateways:transitGatewayId=${identifier}`;
    case 'ROUTE53RESOLVER':
      return `https://${awsRegion}.console.aws.amazon.com/route53resolver/home?region=${awsRegion}#/endpoint/${identifier}`;
    default:
      return null;
  }
}

// ─── Slack Message Building ──────────────────────────────────────────────────

function buildSlackMessage(
  event: AlarmStateChangeEvent,
  parsed: ParsedAlarmInfo,
  enrichment: EnrichmentContext,
  metricsGraphUrl: string | null,
  resourceUrl: string | null,
): SlackMessage {
  const {detail, account} = event;
  const eventRegion = event.region;
  const state = detail.state.value;
  const stateLabel = state === 'OK' ? 'RESOLVED' : 'ALARM';
  const emoji = state === 'OK' ? '\u{1F7E2}' : '\u{1F534}';
  const color = getAlarmColor(state, parsed.classification);

  const headerText = `${emoji} ${stateLabel} | ${parsed.service} ${parsed.identifier} \u2014 ${parsed.metricName}`;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {type: 'plain_text', text: headerText, emoji: true},
    },
  ];

  // ── Metadata fields ──
  const fields: Array<{type: string; text: string}> = [
    {type: 'mrkdwn', text: `*Severity:*\n${parsed.classification}`},
    {type: 'mrkdwn', text: `*Account:*\n${account}`},
    {type: 'mrkdwn', text: `*Region:*\n${eventRegion}`},
    {
      type: 'mrkdwn',
      text: `*Type:*\n${parsed.isAnomaly ? 'Anomaly Detection' : 'Static Threshold'}`,
    },
  ];

  if (enrichment.owner)
    fields.push({type: 'mrkdwn', text: `*Owner:*\n${enrichment.owner}`});
  if (enrichment.environment)
    fields.push({
      type: 'mrkdwn',
      text: `*Environment:*\n${enrichment.environment}`,
    });
  if (enrichment.application)
    fields.push({
      type: 'mrkdwn',
      text: `*Application:*\n${enrichment.application}`,
    });

  if (state === 'OK') {
    fields.push({
      type: 'mrkdwn',
      text: `*Previous State:*\n${detail.previousState.value}`,
    });
    const prevTs = new Date(detail.previousState.timestamp).getTime();
    const curTs = new Date(detail.state.timestamp).getTime();
    const durationMin = Math.round((curTs - prevTs) / 60_000);
    if (durationMin > 0) {
      fields.push({
        type: 'mrkdwn',
        text: `*Alarm Duration:*\n~${durationMin} min`,
      });
    }
  }

  blocks.push({type: 'section', fields});

  // ── Reason (ALARM only) ──
  if (state === 'ALARM') {
    blocks.push({
      type: 'section',
      text: {type: 'mrkdwn', text: `*Reason:*\n${detail.state.reason}`},
    });
  }

  // ── Triggering Metric Trend ──
  if (enrichment.triggeringMetricTrend.length > 0) {
    const trend = buildTrendSummary(
      enrichment.triggeringMetricTrend,
      enrichment.threshold,
    );
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*\u{1F4C8} ${parsed.metricName} (1h):*\n\`${trend}\``,
      },
    });
  }

  // ── Correlated Metrics (ALARM only) ──
  if (state === 'ALARM' && enrichment.correlatedMetrics.length > 0) {
    const metricLines = enrichment.correlatedMetrics
      .map(
        (m) =>
          `\u2022 ${m.name}: ${formatValue(m.current)} ${trendEmoji(m.trend)}`,
      )
      .join('\n');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*\u{1F4CA} Correlated Metrics:*\n${metricLines}`,
      },
    });
  }

  // ── Related Alarms (ALARM only) ──
  if (state === 'ALARM' && enrichment.relatedAlarms.length > 0) {
    const alarmList = enrichment.relatedAlarms
      .map((a) => `\u2022 ${a.metric}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*\u{26A0}\u{FE0F} ${enrichment.relatedAlarms.length} related alarm${enrichment.relatedAlarms.length > 1 ? 's' : ''} also firing:*\n${alarmList}`,
      },
    });
  }

  // ── Recent Changes (ALARM only) ──
  if (state === 'ALARM' && enrichment.recentChanges.length > 0) {
    const changeList = enrichment.recentChanges
      .map(
        (c) =>
          `\u2022 \`${c.event}\` by ${c.user} \u2014 ${relativeTime(c.time)}`,
      )
      .join('\n');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*\u{1F504} Recent Changes (CloudTrail):*\n${changeList}`,
      },
    });
  }

  // ── Runbook ──
  if (enrichment.runbookUrl) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*\u{1F4D6} Runbook:* <${enrichment.runbookUrl}|Open Runbook>`,
      },
    });
  }

  // ── Action Buttons ──
  blocks.push({type: 'divider'});

  const buttons: Array<{
    type: string;
    text: {type: string; text: string; emoji: boolean};
    url: string;
  }> = [
    {
      type: 'button',
      text: {type: 'plain_text', text: 'View Alarm', emoji: true},
      url: getConsoleUrl(detail.alarmName, eventRegion),
    },
  ];

  if (resourceUrl) {
    buttons.push({
      type: 'button',
      text: {type: 'plain_text', text: 'View Resource', emoji: true},
      url: resourceUrl,
    });
  }

  if (metricsGraphUrl) {
    buttons.push({
      type: 'button',
      text: {type: 'plain_text', text: 'Metrics Graph', emoji: true},
      url: metricsGraphUrl,
    });
  }

  if (state === 'ALARM') {
    buttons.push({
      type: 'button',
      text: {type: 'plain_text', text: 'CloudTrail', emoji: true},
      url: getCloudTrailUrl(parsed.identifier, eventRegion),
    });
  }

  blocks.push({type: 'actions', elements: buttons});

  return {attachments: [{color, blocks}]};
}

// ─── Slack API ───────────────────────────────────────────────────────────────

async function postToSlack(
  webhookUrl: string,
  message: SlackMessage,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack API returned ${response.status}: ${body}`);
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export const handler = async (event: AlarmStateChangeEvent): Promise<void> => {
  const {detail} = event;
  const alarmArn = event.resources?.[0] || '';

  log
    .info()
    .str('function', 'handler')
    .str('alarmName', detail.alarmName)
    .str('state', detail.state.value)
    .str('previousState', detail.previousState.value)
    .msg('Processing alarm state change event');

  const metricStat = detail.configuration?.metrics?.find(
    (m) => m.metricStat,
  )?.metricStat;
  const parsed = parseAlarmName(detail.alarmName, metricStat?.metric.name);

  // Run all enrichment calls in parallel — each fails gracefully
  const [tagsResult, relatedResult, trendResult, correlatedResult, changesResult] =
    await Promise.allSettled([
      fetchAlarmTags(alarmArn),
      fetchRelatedAlarms(parsed.service, parsed.identifier, detail.alarmName),
      metricStat
        ? fetchMetricTrend(metricStat)
        : Promise.resolve({datapoints: []}),
      fetchCorrelatedMetrics(
        parsed.service,
        parsed.metricName,
        parsed.identifier,
      ),
      fetchRecentChanges(parsed.service, parsed.identifier),
    ]);

  const alarmTags =
    tagsResult.status === 'fulfilled' ? tagsResult.value : {};
  const ownership = resolveOwnership(alarmTags);

  const runbookUrl = await resolveRunbookUrl(
    parsed.service,
    parsed.metricName,
    alarmTags['autoalarm:runbook-url'],
  );

  // Build metrics graph deep link if we have metric info
  let metricsGraphUrl: string | null = null;
  if (metricStat) {
    const dimensions = Object.entries(metricStat.metric.dimensions).map(
      ([Name, Value]) => ({Name, Value}),
    );
    metricsGraphUrl = getMetricsGraphUrl(
      event.region,
      metricStat.metric.namespace,
      metricStat.metric.name,
      dimensions,
    );
  }

  const enrichment: EnrichmentContext = {
    ...ownership,
    relatedAlarms:
      relatedResult.status === 'fulfilled' ? relatedResult.value : [],
    triggeringMetricTrend:
      trendResult.status === 'fulfilled' ? trendResult.value.datapoints : [],
    correlatedMetrics:
      correlatedResult.status === 'fulfilled' ? correlatedResult.value : [],
    threshold: parseThresholdFromReason(detail.state.reasonData),
    recentChanges:
      changesResult.status === 'fulfilled' ? changesResult.value : [],
    runbookUrl,
  };

  const resourceUrl = getResourceUrl(parsed.service, parsed.identifier, event.region);
  const webhookUrl = await getWebhookUrl();
  const message = buildSlackMessage(event, parsed, enrichment, metricsGraphUrl, resourceUrl);

  await postToSlack(webhookUrl, message);

  log
    .info()
    .str('function', 'handler')
    .str('alarmName', detail.alarmName)
    .num('relatedAlarms', enrichment.relatedAlarms.length)
    .num('trendPoints', enrichment.triggeringMetricTrend.length)
    .num('correlatedMetrics', enrichment.correlatedMetrics.length)
    .num('recentChanges', enrichment.recentChanges.length)
    .msg('Successfully posted enriched notification to Slack');
};
