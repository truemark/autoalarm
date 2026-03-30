import {SQSEvent, SQSBatchResponse, SQSBatchItemFailure} from 'aws-lambda';
import {
  CloudWatchClient,
  GetMetricDataCommand,
  DescribeAlarmsCommand,
  ListTagsForResourceCommand,
  StateValue,
  AlarmType,
} from '@aws-sdk/client-cloudwatch';
import {safeParse, flatten} from 'valibot';
import {AlarmStateChangeEventSchema} from './types/index.mjs';
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CloudTrailClient,
  LookupEventsCommand,
} from '@aws-sdk/client-cloudtrail';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import {SNSClient, PublishCommand} from '@aws-sdk/client-sns';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import * as logging from '@nr1e/logging';
import type {
  EnrichedAlarmEvent,
  ParsedAlarmIdentity,
  CorrelatedMetric,
  RecentError,
  RecentDeployment,
  DeepLinks,
  EnrichmentMetadata,
  AgentSummary,
  EnrichmentMessageAttributes,
} from './types/index.mjs';

const level = process.env.LOG_LEVEL || 'trace';
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'enrichment-handler',
  level: logging.isLevel(level) ? level : 'trace',
});
const region = process.env.REGION || process.env.AWS_REGION || '';
const snsTopicArn = process.env.SNS_TOPIC_ARN || '';
const idempotencyTableName = process.env.IDEMPOTENCY_TABLE_NAME || '';
const agentEnabled = process.env.AGENT_ENABLED === 'true';
const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN || '';
const agentSeverityFilter: string[] = JSON.parse(
  process.env.AGENT_SEVERITY_FILTER || '["Critical"]',
);
const dashboardTemplates: Record<string, string> = JSON.parse(
  process.env.DASHBOARD_TEMPLATES || '{}',
);

const retryStrategy = new ConfiguredRetryStrategy(5);
const cwClient = new CloudWatchClient({region, retryStrategy});
const logsClient = new CloudWatchLogsClient({region, retryStrategy});
const ctClient = new CloudTrailClient({region, retryStrategy});
const ddbClient = new DynamoDBClient({region, retryStrategy});
const snsClient = new SNSClient({region, retryStrategy});

// Correlated metrics map: service → metric → correlated metrics
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
      metrics: [
        'TargetResponseTime',
        'UnHealthyHostCount',
        'RequestCount',
      ],
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
      metrics: [
        'ExecutionsStarted',
        'ExecutionsTimedOut',
        'ExecutionThrottled',
      ],
    },
  },
};

// CloudTrail event names by service for deployment detection
const DEPLOYMENT_EVENTS: Record<string, string[]> = {
  EC2: ['RunInstances', 'StopInstances', 'TerminateInstances'],
  RDS: ['ModifyDBInstance', 'RebootDBInstance', 'ModifyDBCluster'],
  ALB: ['ModifyLoadBalancerAttributes', 'ModifyTargetGroup'],
  ECS: ['UpdateService', 'RegisterTaskDefinition'],
  SFN: ['UpdateStateMachine'],
  OPENSEARCH: ['UpdateDomainConfig'],
};

/**
 * Parse the AutoAlarm alarm name into its components.
 * Format: AutoAlarm-{SERVICE}-{IDENTIFIER}-{METRIC}-[STORAGEPATH]-{anomaly?}-{CLASSIFICATION}
 */
export function parseAlarmName(alarmName: string): ParsedAlarmIdentity | null {
  // Remove the AutoAlarm- prefix
  if (!alarmName.startsWith('AutoAlarm-')) return null;
  const rest = alarmName.slice('AutoAlarm-'.length);

  // Classification is always the last segment
  const parts = rest.split('-');
  if (parts.length < 4) return null;

  const severity = parts[parts.length - 1];
  if (severity !== 'Critical' && severity !== 'Warning') return null;

  // Check if second-to-last is 'anomaly'
  const isAnomaly = parts[parts.length - 2] === 'anomaly';
  const alarmType = isAnomaly ? 'anomaly' : 'static';

  // Service is always first
  const service = parts[0];

  // Identifier and metric need heuristic parsing since identifier can contain dashes
  // The metric is typically one segment (e.g., CPUUtilization, FreeableMemory)
  // but identifier can be multi-segment (e.g., app/my-alb/123)
  const endIdx = parts.length - (isAnomaly ? 2 : 1);

  // Try to find the metric by checking known metric names from last inward
  let metric = parts[endIdx - 1];
  let identifier = parts.slice(1, endIdx - 1).join('-');

  // Handle storage path (e.g., for EC2 storage alarms: ...-StorageUtilization-/dev/sda1-...)
  // Storage path segments would be between metric and anomaly/classification

  return {
    service,
    identifier,
    metric,
    alarmType: alarmType as 'static' | 'anomaly',
    severity: severity as 'Critical' | 'Warning',
  };
}

/**
 * Check idempotency table. Returns true if this event has already been processed.
 */
async function checkIdempotency(key: string): Promise<boolean> {
  try {
    const result = await ddbClient.send(
      new GetItemCommand({
        TableName: idempotencyTableName,
        Key: {idempotencyKey: {S: key}},
      }),
    );
    return !!result.Item;
  } catch (e) {
    log
      .warn()
      .str('idempotencyKey', key)
      .err(e)
      .msg('Failed idempotency check, proceeding without dedup');
    return false;
  }
}

/**
 * Record idempotency key with 24-hour TTL.
 */
async function recordIdempotency(key: string): Promise<void> {
  try {
    const ttl = Math.floor(Date.now() / 1000) + 86400; // 24 hours
    await ddbClient.send(
      new PutItemCommand({
        TableName: idempotencyTableName,
        Item: {
          idempotencyKey: {S: key},
          ttl: {N: ttl.toString()},
        },
      }),
    );
  } catch (e) {
    log
      .warn()
      .str('idempotencyKey', key)
      .err(e)
      .msg('Failed to record idempotency key');
  }
}

/**
 * Fetch alarm tags from CloudWatch.
 */
async function fetchAlarmTags(
  alarmArn: string,
): Promise<Record<string, string>> {
  try {
    const result = await cwClient.send(
      new ListTagsForResourceCommand({ResourceARN: alarmArn}),
    );
    const tags: Record<string, string> = {};
    for (const tag of result.Tags ?? []) {
      if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
    }
    return tags;
  } catch (e) {
    log.warn().str('alarmArn', alarmArn).err(e).msg('Failed to fetch alarm tags');
    return {};
  }
}

/**
 * Resolve owner, environment, and application from tags (case-insensitive).
 */
export function resolveOwnership(tags: Record<string, string>): {
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
    owner: find('owner', 'Owner', 'team', 'Team'),
    environment: find('environment', 'Environment', 'env', 'Env'),
    application: find('application', 'Application', 'app', 'App'),
  };
}

/**
 * Query correlated metrics using GetMetricData.
 */
async function queryCorrelatedMetrics(
  parsed: ParsedAlarmIdentity,
  sourceAccount: string,
  alarmTimestamp: Date,
  dimensions: {Name: string; Value: string}[],
): Promise<CorrelatedMetric[]> {
  const serviceMetrics =
    CORRELATED_METRICS[parsed.service]?.[parsed.metric];
  if (!serviceMetrics) return [];

  const startTime = new Date(alarmTimestamp.getTime() - 30 * 60 * 1000);
  const endTime = alarmTimestamp;

  const metricDataQueries = serviceMetrics.metrics.slice(0, 10).map(
    (metricName, idx) => ({
      Id: `m${idx}`,
      MetricStat: {
        Metric: {
          Namespace: serviceMetrics.namespace,
          MetricName: metricName,
          Dimensions: dimensions,
        },
        Period: 60,
        Stat: 'Average',
      },
    }),
  );

  try {
    const result = await cwClient.send(
      new GetMetricDataCommand({
        MetricDataQueries: metricDataQueries,
        StartTime: startTime,
        EndTime: endTime,
      }),
    );

    return (result.MetricDataResults ?? []).map((mdr, idx) => {
      const values = mdr.Values ?? [];
      const trend = computeTrend(values);
      const metricName = serviceMetrics.metrics[idx];
      return {
        name: metricName,
        namespace: serviceMetrics.namespace,
        values: values,
        trend,
        current: values.length > 0 ? values[values.length - 1] : 0,
        link: buildMetricGraphLink(
          region,
          serviceMetrics.namespace,
          metricName,
          dimensions,
        ),
      };
    });
  } catch (e) {
    log
      .warn()
      .str('service', parsed.service)
      .str('metric', parsed.metric)
      .err(e)
      .msg('Failed to query correlated metrics');
    return [];
  }
}

/**
 * Compute trend from data points using simple comparison.
 */
export function computeTrend(values: number[]): 'rising' | 'falling' | 'stable' {
  if (values.length < 2) return 'stable';
  const first = values.slice(0, Math.ceil(values.length / 3));
  const last = values.slice(-Math.ceil(values.length / 3));
  const avgFirst = first.reduce((a, b) => a + b, 0) / first.length;
  const avgLast = last.reduce((a, b) => a + b, 0) / last.length;
  const threshold = avgFirst * 0.1 || 1; // 10% change threshold
  if (avgLast > avgFirst + threshold) return 'rising';
  if (avgLast < avgFirst - threshold) return 'falling';
  return 'stable';
}

/**
 * Query CloudWatch Logs Insights for recent errors.
 * Has a hard 10-second timeout.
 */
async function queryRecentErrors(
  logGroupArn: string,
  alarmTimestamp: Date,
): Promise<RecentError[] | null> {
  const startTime = new Date(alarmTimestamp.getTime() - 15 * 60 * 1000);
  const query = `filter @message like /(?i)(error|exception|fatal|timeout|oom)/ | stats count(*) as cnt, min(@timestamp) as firstSeen, max(@timestamp) as lastSeen by @message | sort cnt desc | limit 10`;

  let queryId: string | undefined;
  try {
    const startResult = await logsClient.send(
      new StartQueryCommand({
        logGroupIdentifiers: [logGroupArn],
        startTime: Math.floor(startTime.getTime() / 1000),
        endTime: Math.floor(alarmTimestamp.getTime() / 1000),
        queryString: query,
      }),
    );
    queryId = startResult.queryId;
    if (!queryId) return null;

    // Poll with 10-second hard timeout
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const results = await logsClient.send(
        new GetQueryResultsCommand({queryId}),
      );
      if (results.status === 'Complete') {
        return (results.results ?? []).map((row) => {
          const fields: Record<string, string> = {};
          for (const f of row) {
            if (f.field && f.value) fields[f.field] = f.value;
          }
          return {
            message: (fields['@message'] ?? '').slice(0, 200),
            count: parseInt(fields['cnt'] ?? '0', 10),
            firstSeen: fields['firstSeen'] ?? '',
            lastSeen: fields['lastSeen'] ?? '',
          };
        });
      }
      if (results.status === 'Failed' || results.status === 'Cancelled') {
        return null;
      }
    }

    // Timeout — stop the query
    await logsClient.send(new StopQueryCommand({queryId}));
    return null;
  } catch (e) {
    log
      .warn()
      .str('logGroupArn', logGroupArn)
      .err(e)
      .msg('Failed to query recent errors');
    if (queryId) {
      try {
        await logsClient.send(new StopQueryCommand({queryId}));
      } catch {
        // best effort
      }
    }
    return null;
  }
}

/**
 * Query CloudTrail for recent deployment-related events.
 */
async function queryRecentDeployments(
  service: string,
  identifier: string,
  alarmTimestamp: Date,
): Promise<RecentDeployment[]> {
  const eventNames = DEPLOYMENT_EVENTS[service];
  if (!eventNames) return [];

  try {
    const startTime = new Date(alarmTimestamp.getTime() - 2 * 60 * 60 * 1000);
    const result = await ctClient.send(
      new LookupEventsCommand({
        LookupAttributes: [
          {AttributeKey: 'ResourceName', AttributeValue: identifier},
        ],
        StartTime: startTime,
        EndTime: alarmTimestamp,
        MaxResults: 5,
      }),
    );

    return (result.Events ?? [])
      .filter((e) => eventNames.includes(e.EventName ?? ''))
      .map((e) => {
        let sourceIPAddress = '';
        if (e.CloudTrailEvent) {
          try {
            const parsed = JSON.parse(e.CloudTrailEvent);
            sourceIPAddress = parsed.sourceIPAddress ?? '';
          } catch {
            // ignore parse errors
          }
        }
        return {
          eventName: e.EventName ?? '',
          timestamp: e.EventTime?.toISOString() ?? '',
          username: e.Username ?? '',
          sourceIPAddress,
          link: buildCloudTrailEventLink(region, e.EventId ?? ''),
        };
      });
  } catch (e) {
    log
      .warn()
      .str('service', service)
      .str('identifier', identifier)
      .err(e)
      .msg('Failed to query recent deployments');
    return [];
  }
}

/**
 * Resolve runbook URL from tags or static mapping.
 */
export function resolveRunbookUrl(
  tags: Record<string, string>,
  service: string,
  metric: string,
): string | null {
  // 1. Resource tag
  if (tags['autoalarm:runbook-url']) return tags['autoalarm:runbook-url'];
  // 2. Static mapping would be loaded from env/config (not implemented in this iteration)
  return null;
}

/**
 * Resolve dashboard URL from tags or template mapping.
 */
export function resolveDashboardUrl(
  tags: Record<string, string>,
  service: string,
  identifier: string,
): string | null {
  if (tags['autoalarm:dashboard-url']) return tags['autoalarm:dashboard-url'];
  const template = dashboardTemplates[service];
  if (template) return template.replace('{identifier}', identifier);
  return null;
}

/**
 * Query concurrent alarms for the same resource (correlation window).
 * Uses DescribeAlarms with the service+identifier prefix to find all
 * AutoAlarm-* alarms currently in ALARM state for this resource.
 */
async function queryCorrelationWindow(
  service: string,
  identifier: string,
): Promise<{concurrentAlarms: number; relatedAlarmNames: string[]}> {
  try {
    const prefix = `AutoAlarm-${service}-${identifier}-`;
    const result = await cwClient.send(
      new DescribeAlarmsCommand({
        AlarmNamePrefix: prefix,
        StateValue: StateValue.ALARM,
        AlarmTypes: [AlarmType.MetricAlarm],
        MaxRecords: 50,
      }),
    );
    const alarms = result.MetricAlarms ?? [];
    return {
      concurrentAlarms: alarms.length,
      relatedAlarmNames: alarms.map((a) => a.AlarmName ?? '').filter(Boolean),
    };
  } catch (e) {
    log
      .warn()
      .str('service', service)
      .str('identifier', identifier)
      .err(e)
      .msg('Failed to query correlation window');
    return {concurrentAlarms: 0, relatedAlarmNames: []};
  }
}

// --- Deep link builders ---

export function buildAlarmConsoleLink(
  reg: string,
  alarmName: string,
): string {
  return `https://${reg}.console.aws.amazon.com/cloudwatch/home?region=${reg}#alarmsV2:alarm/${encodeURIComponent(alarmName)}`;
}

export function buildMetricGraphLink(
  reg: string,
  namespace: string,
  metricName: string,
  dimensions: {Name: string; Value: string}[],
): string {
  const dimStr = dimensions
    .map((d) => `~'${d.Name}~'${d.Value}`)
    .join('');
  return `https://${reg}.console.aws.amazon.com/cloudwatch/home?region=${reg}#metricsV2:graph=~(metrics~(~(~'${namespace.replace(/\//g, '*2f')}~'${metricName}${dimStr}))~view~'timeSeries~region~'${reg}~stat~'Average~period~60)`;
}

export function buildCloudTrailLink(
  reg: string,
  resourceName: string,
): string {
  return `https://${reg}.console.aws.amazon.com/cloudtrailv2/home?region=${reg}#/events?ResourceName=${encodeURIComponent(resourceName)}`;
}

function buildCloudTrailEventLink(
  reg: string,
  eventId: string,
): string {
  return `https://${reg}.console.aws.amazon.com/cloudtrailv2/home?region=${reg}#/events/${eventId}`;
}

/**
 * Build the deterministic fallback agent summary.
 */
export function buildFallbackSummary(
  severity: string,
  service: string,
  identifier: string,
  metric: string,
  runbookUrl: string | null,
): AgentSummary {
  return {
    summary: `${severity} alarm on ${service}/${identifier}: ${metric} crossed threshold.`,
    rootCauseHypothesis:
      'Unable to generate hypothesis (agent unavailable).',
    recommendedActions: [
      runbookUrl
        ? `Check runbook: ${runbookUrl}`
        : 'Check service health in the CloudWatch console.',
      'Review correlated metrics and recent deployments in the enriched payload.',
    ],
    confidence: 'low',
    source: 'fallback',
  };
}

/**
 * Publish enriched event to SNS.
 */
async function publishEnrichedEvent(
  event: EnrichedAlarmEvent,
): Promise<void> {
  const isDegraded =
    event.context.correlatedMetrics.length === 0 ||
    event.context.recentErrors === null ||
    event.enrichment.logsSkipped;

  const attrs: EnrichmentMessageAttributes = {
    schemaVersion: event.version,
    severity: event.alarm.severity,
    service: event.resource.service,
    sourceAccount: event.resource.account,
    region: event.resource.region,
    hasAgentSummary: event.agentSummary ? 'true' : 'false',
    isDegraded: isDegraded ? 'true' : 'false',
  };

  const ownership = resolveOwnership(event.resource.tags);
  if (ownership.environment) attrs.environment = ownership.environment;
  if (ownership.owner) attrs.owner = ownership.owner;

  await snsClient.send(
    new PublishCommand({
      TopicArn: snsTopicArn,
      Message: JSON.stringify(event),
      MessageAttributes: Object.fromEntries(
        Object.entries(attrs)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, {DataType: 'String', StringValue: v}]),
      ),
    }),
  );
}

/**
 * Get dimensions for a service/identifier pair.
 */
export function getDimensions(
  service: string,
  identifier: string,
): {Name: string; Value: string}[] {
  const dimensionMap: Record<string, string> = {
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

  const dimName = dimensionMap[service] || 'ResourceId';
  return [{Name: dimName, Value: identifier}];
}

/**
 * Main Lambda handler for alarm enrichment.
 */
export async function handler(
  event: SQSEvent,
): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    const startTime = Date.now();
    try {
      // Parse and validate the EventBridge event from the SQS message body
      let rawBody: unknown;
      try {
        rawBody = JSON.parse(record.body);
      } catch {
        log
          .error()
          .str('messageId', record.messageId)
          .msg('SQS message body is not valid JSON — sending to DLQ');
        batchItemFailures.push({itemIdentifier: record.messageId});
        continue;
      }

      const parseResult = safeParse(AlarmStateChangeEventSchema, rawBody);
      if (!parseResult.success) {
        log
          .error()
          .str('messageId', record.messageId)
          .str('issues', JSON.stringify(flatten(parseResult.issues)))
          .msg('SQS message failed schema validation — sending to DLQ');
        batchItemFailures.push({itemIdentifier: record.messageId});
        continue;
      }

      const ebEvent = parseResult.output;
      const detail = ebEvent.detail;
      const alarmName: string = detail.alarmName;
      const alarmArn: string =
        detail.alarmArn ??
        `arn:aws:cloudwatch:${ebEvent.region}:${ebEvent.account}:alarm:${alarmName}`;
      const sourceAccount: string = ebEvent.account;
      const sourceRegion: string = ebEvent.region;
      const stateChangeTime: string = detail.state.timestamp ?? ebEvent.time ?? '';

      // Step 1: Parse alarm identity
      const parsed = parseAlarmName(alarmName);
      if (!parsed) {
        log
          .error()
          .str('alarmName', alarmName)
          .msg('Failed to parse alarm name — sending to DLQ');
        batchItemFailures.push({itemIdentifier: record.messageId});
        continue;
      }

      // Step 2: Idempotency check
      const idempotencyKey = `${alarmArn}:${stateChangeTime}:ALARM`;
      const isDuplicate = await checkIdempotency(idempotencyKey);
      if (isDuplicate) {
        log
          .info()
          .str('idempotencyKey', idempotencyKey)
          .msg('Duplicate event, skipping');
        continue;
      }

      const alarmTimestamp = new Date(stateChangeTime);
      const dimensions = getDimensions(parsed.service, parsed.identifier);

      // Steps 3-6: Parallel enrichment queries
      const [alarmTags, correlatedMetrics, recentDeployments, correlationWindow] =
        await Promise.allSettled([
          fetchAlarmTags(alarmArn),
          queryCorrelatedMetrics(
            parsed,
            sourceAccount,
            alarmTimestamp,
            dimensions,
          ),
          queryRecentDeployments(
            parsed.service,
            parsed.identifier,
            alarmTimestamp,
          ),
          queryCorrelationWindow(parsed.service, parsed.identifier),
        ]);

      const tags =
        alarmTags.status === 'fulfilled' ? alarmTags.value : {};
      const metrics =
        correlatedMetrics.status === 'fulfilled'
          ? correlatedMetrics.value
          : [];
      const deployments =
        recentDeployments.status === 'fulfilled'
          ? recentDeployments.value
          : [];
      const corrWindow =
        correlationWindow.status === 'fulfilled'
          ? correlationWindow.value
          : undefined;

      // Step 5: Logs (run separately due to polling nature)
      // TODO: Determine log group ARN from service type + identifier
      // For now, skip logs — requires OAM validation and log group discovery
      let recentErrors: RecentError[] | null = null;
      let logsSkipped = true;
      let logsSkipReason: 'timeout' | 'no_log_group' | 'error' | 'disabled' =
        'no_log_group';

      // Step 7: Resolve runbook and dashboard
      const ownership = resolveOwnership(tags);
      const runbookUrl = resolveRunbookUrl(
        tags,
        parsed.service,
        parsed.metric,
      );
      const dashboardUrl = resolveDashboardUrl(
        tags,
        parsed.service,
        parsed.identifier,
      );

      // Step 8-9: Build links
      const links: DeepLinks = {
        alarmConsole: buildAlarmConsoleLink(sourceRegion, alarmName),
        metricsGraph: buildMetricGraphLink(
          sourceRegion,
          CORRELATED_METRICS[parsed.service]?.[parsed.metric]?.namespace ??
            'AWS/Unknown',
          parsed.metric,
          dimensions,
        ),
        logsInsights: null, // TODO: populate when log group discovery is implemented
        dashboard: dashboardUrl,
        runbook: runbookUrl,
        cloudTrail: buildCloudTrailLink(sourceRegion, parsed.identifier),
      };

      // Step 10: Build enrichment metadata
      const enrichmentMeta: EnrichmentMetadata = {
        timestamp: new Date().toISOString(),
        version: '1.0',
        idempotencyKey,
        durationMs: 0, // updated before publish
        logsSkipped,
        logsSkipReason,
        agentInvoked: false,
        ...(corrWindow && corrWindow.concurrentAlarms > 0
          ? {correlationWindow: corrWindow}
          : {}),
      };

      // Step 10: Conditional agent invocation
      let agentSummary: AgentSummary | undefined;
      if (
        agentEnabled &&
        agentSeverityFilter.includes(parsed.severity) &&
        agentRuntimeArn
      ) {
        // TODO: Implement AgentCore invocation once runtime API is validated
        // For now, use the fallback template
        enrichmentMeta.agentInvoked = false;
        enrichmentMeta.agentSkipReason = 'disabled';
        agentSummary = buildFallbackSummary(
          parsed.severity,
          parsed.service,
          parsed.identifier,
          parsed.metric,
          runbookUrl,
        );
      }

      // Compose final payload
      enrichmentMeta.durationMs = Date.now() - startTime;

      const enrichedEvent: EnrichedAlarmEvent = {
        version: '1.0',
        alarm: {
          name: alarmName,
          arn: alarmArn,
          state: 'ALARM',
          // EventBridge rule guarantees previousState is OK or INSUFFICIENT_DATA
          previousState: (detail.previousState?.value ?? 'OK') as
            | 'OK'
            | 'INSUFFICIENT_DATA',
          reason: detail.state.reason ?? '',
          timestamp: stateChangeTime,
          severity: parsed.severity,
          metric: parsed.metric,
          namespace:
            CORRELATED_METRICS[parsed.service]?.[parsed.metric]?.namespace ??
            '',
          alarmType: parsed.alarmType,
          // metrics array elements are untyped (unknown) — best-effort extraction
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          threshold: (detail.configuration?.metrics?.[0] as any)?.metricStat
            ?.stat?.threshold ?? null,
          currentValue: null, // TODO: extract from state reason
        },
        resource: {
          service: parsed.service,
          identifier: parsed.identifier,
          account: sourceAccount,
          region: sourceRegion,
          tags,
          ...ownership,
        },
        context: {
          correlatedMetrics: metrics,
          recentErrors,
          recentDeployments: deployments,
          runbookUrl,
        },
        links,
        enrichment: enrichmentMeta,
        agentSummary,
      };

      // Step 11: Publish
      await publishEnrichedEvent(enrichedEvent);
      await recordIdempotency(idempotencyKey);

      log
        .info()
        .str('alarmName', alarmName)
        .num('durationMs', enrichmentMeta.durationMs)
        .str('severity', parsed.severity)
        .str('service', parsed.service)
        .msg('Successfully enriched and published alarm event');
    } catch (e) {
      log
        .error()
        .str('messageId', record.messageId)
        .err(e)
        .msg('Failed to process enrichment event');
      batchItemFailures.push({itemIdentifier: record.messageId});
    }
  }

  return {batchItemFailures};
}
