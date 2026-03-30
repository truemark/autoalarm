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

interface EnrichmentContext {
  alarmTags: Record<string, string>;
  relatedAlarms: Array<{name: string; metric: string}>;
  metricTrend: Array<{timestamp: Date; value: number}>;
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

async function fetchRecentChanges(
  identifier: string,
): Promise<Array<{event: string; time: Date; user: string}>> {
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
        MaxResults: 5,
      }),
    );

    return (response.Events || [])
      .filter(
        (evt): evt is typeof evt & {EventName: string; EventTime: Date} =>
          evt.EventName !== undefined && evt.EventTime !== undefined,
      )
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
    // Convert wiki page URL to raw markdown URL
    // https://github.com/org/repo/wiki/Page → https://raw.githubusercontent.com/wiki/org/repo/Page.md
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
  // Split camelCase/PascalCase, then lowercase and split on non-alpha
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

  // Require at least 2 token matches to avoid false positives
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

  // Fall back to the top-level runbook page
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

function buildTrendSummary(
  datapoints: Array<{timestamp: Date; value: number}>,
  threshold: number | null,
): string {
  if (datapoints.length === 0) return 'No data available';

  // Sample ~5 points for a compact summary
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

function getCloudTrailUrl(identifier: string, awsRegion: string): string {
  const encoded = encodeURIComponent(identifier);
  return `https://${awsRegion}.console.aws.amazon.com/cloudtrailv2/home?region=${awsRegion}#/events?ResourceName=${encoded}`;
}

// ─── Slack Message Building ──────────────────────────────────────────────────

function buildSlackMessage(
  event: AlarmStateChangeEvent,
  parsed: ParsedAlarmInfo,
  enrichment: EnrichmentContext,
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

  // Include tag-based metadata if available
  const owner = enrichment.alarmTags['autoalarm:owner'];
  const env = enrichment.alarmTags['autoalarm:environment'];
  if (owner) fields.push({type: 'mrkdwn', text: `*Owner:*\n${owner}`});
  if (env) fields.push({type: 'mrkdwn', text: `*Environment:*\n${env}`});

  if (state === 'OK') {
    fields.push({
      type: 'mrkdwn',
      text: `*Previous State:*\n${detail.previousState.value}`,
    });
    // Show approximate alarm duration
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

  // ── Metric Trend ──
  if (enrichment.metricTrend.length > 0) {
    const trend = buildTrendSummary(
      enrichment.metricTrend,
      enrichment.threshold,
    );
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*\u{1F4C8} Metric Trend (1h):*\n\`${trend}\``,
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
      .map((c) => `\u2022 \`${c.event}\` by ${c.user} \u2014 ${relativeTime(c.time)}`)
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

  // Parse alarm identity from the event
  const metricStat = detail.configuration?.metrics?.find(
    (m) => m.metricStat,
  )?.metricStat;
  const parsed = parseAlarmName(detail.alarmName, metricStat?.metric.name);

  // Run all enrichment calls in parallel — each fails gracefully
  const [tagsResult, relatedResult, trendResult, changesResult] =
    await Promise.allSettled([
      fetchAlarmTags(alarmArn),
      fetchRelatedAlarms(parsed.service, parsed.identifier, detail.alarmName),
      metricStat
        ? fetchMetricTrend(metricStat)
        : Promise.resolve({datapoints: []}),
      fetchRecentChanges(parsed.identifier),
    ]);

  const alarmTags =
    tagsResult.status === 'fulfilled' ? tagsResult.value : {};

  // Resolve runbook: tag override > dynamic match > base URL fallback
  const runbookUrl = await resolveRunbookUrl(
    parsed.service,
    parsed.metricName,
    alarmTags['autoalarm:runbook-url'],
  );

  const enrichment: EnrichmentContext = {
    alarmTags,
    relatedAlarms:
      relatedResult.status === 'fulfilled' ? relatedResult.value : [],
    metricTrend:
      trendResult.status === 'fulfilled' ? trendResult.value.datapoints : [],
    threshold: parseThresholdFromReason(detail.state.reasonData),
    recentChanges:
      changesResult.status === 'fulfilled' ? changesResult.value : [],
    runbookUrl,
  };

  const webhookUrl = await getWebhookUrl();
  const message = buildSlackMessage(event, parsed, enrichment);

  await postToSlack(webhookUrl, message);

  log
    .info()
    .str('function', 'handler')
    .str('alarmName', detail.alarmName)
    .num('relatedAlarms', enrichment.relatedAlarms.length)
    .num('trendPoints', enrichment.metricTrend.length)
    .num('recentChanges', enrichment.recentChanges.length)
    .msg('Successfully posted enriched notification to Slack');
};
