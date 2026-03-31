/**
 * Unit and integration tests for enrichment-handler.mts.
 *
 * Pure-function tests run without any AWS mocking.
 * Integration tests use aws-sdk-client-mock to intercept SDK calls.
 *
 * Run individually:
 *   npx vitest run ./src/enrichment-handler.test.mts
 */

// Set env vars before module import so module-level constants are populated.
// NOTE: With vitest ESM, import statements are hoisted before top-level code.
// Env vars set here take effect for non-ESM-hoisted constants only.
// Module-level consts read from process.env at import time (e.g. DASHBOARD_TEMPLATES)
// require a vitest setupFile or inline vi.stubEnv for reliable injection.
process.env.LOG_LEVEL = 'trace';
process.env.REGION = 'us-east-1';
process.env.SNS_TOPIC_ARN =
  'arn:aws:sns:us-east-1:123456789012:AutoAlarm-EnrichedAlarms';
process.env.IDEMPOTENCY_TABLE_NAME = 'AutoAlarm-Enrichment-Idempotency';
process.env.AGENT_ENABLED = 'false';
process.env.AGENT_SEVERITY_FILTER = '["Critical"]';
process.env.DASHBOARD_TEMPLATES = '{}';

import {test, expect, describe, beforeEach} from 'vitest';
import {mockClient} from 'aws-sdk-client-mock';
import {
  CloudWatchClient,
  GetMetricDataCommand,
  DescribeAlarmsCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-cloudwatch';
import {CloudTrailClient, LookupEventsCommand} from '@aws-sdk/client-cloudtrail';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import {SNSClient, PublishCommand} from '@aws-sdk/client-sns';
import {
  parseAlarmName,
  computeTrend,
  resolveOwnership,
  resolveRunbookUrl,
  resolveDashboardUrl,
  getDimensions,
  buildAlarmConsoleLink,
  buildCloudTrailLink,
  buildFallbackSummary,
  handler,
} from './enrichment-handler.mjs';

// ── AWS client mocks ──────────────────────────────────────────────────────────

const cwMock = mockClient(CloudWatchClient);
// @ts-expect-error aws-sdk-client-mock@1.0.0 bundles @smithy/types@4.9.0 which is
// incompatible with the project's @smithy/types@4.13.1 — tests pass at runtime.
const ctMock = mockClient(CloudTrailClient);
const ddbMock = mockClient(DynamoDBClient);
// @ts-expect-error same aws-sdk-client-mock version mismatch
const snsMock = mockClient(SNSClient);

beforeEach(() => {
  cwMock.reset();
  ctMock.reset();
  ddbMock.reset();
  snsMock.reset();
});

// ── parseAlarmName ────────────────────────────────────────────────────────────

describe('parseAlarmName', () => {
  test('parses EC2 static Critical', () => {
    const result = parseAlarmName(
      'AutoAlarm-EC2-i-0abc123-CPUUtilization-Critical',
    );
    expect(result).toEqual({
      service: 'EC2',
      identifier: 'i-0abc123',
      metric: 'CPUUtilization',
      alarmType: 'static',
      severity: 'Critical',
    });
  });

  test('parses RDS static Warning', () => {
    const result = parseAlarmName(
      'AutoAlarm-RDS-db1-FreeableMemory-Warning',
    );
    expect(result).toEqual({
      service: 'RDS',
      identifier: 'db1',
      metric: 'FreeableMemory',
      alarmType: 'static',
      severity: 'Warning',
    });
  });

  test('parses anomaly alarm type', () => {
    const result = parseAlarmName(
      'AutoAlarm-ALB-my-alb-TargetResponseTime-anomaly-Critical',
    );
    expect(result).not.toBeNull();
    expect(result!.alarmType).toBe('anomaly');
    expect(result!.severity).toBe('Critical');
    expect(result!.service).toBe('ALB');
  });

  test('parses ECS service name with dashes in identifier', () => {
    const result = parseAlarmName(
      'AutoAlarm-ECS-my-service-name-CPUUtilization-Warning',
    );
    expect(result).not.toBeNull();
    expect(result!.service).toBe('ECS');
    expect(result!.severity).toBe('Warning');
    expect(result!.metric).toBe('CPUUtilization');
  });

  test('parses SFN service', () => {
    const result = parseAlarmName(
      'AutoAlarm-SFN-arn-aws-states-ExecutionsFailed-Critical',
    );
    expect(result).not.toBeNull();
    expect(result!.service).toBe('SFN');
    expect(result!.metric).toBe('ExecutionsFailed');
    expect(result!.severity).toBe('Critical');
  });

  test('returns null when missing AutoAlarm- prefix', () => {
    expect(parseAlarmName('RDS-db1-CPUUtilization-Critical')).toBeNull();
  });

  test('returns null for too few segments', () => {
    expect(parseAlarmName('AutoAlarm-EC2-Critical')).toBeNull();
  });

  test('returns null for invalid severity', () => {
    expect(
      parseAlarmName('AutoAlarm-EC2-i-0abc123-CPUUtilization-High'),
    ).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseAlarmName('')).toBeNull();
  });
});

// ── computeTrend ──────────────────────────────────────────────────────────────

describe('computeTrend', () => {
  test('rising: steadily increasing values', () => {
    expect(computeTrend([10, 20, 30, 40, 50, 60, 70, 80, 90])).toBe('rising');
  });

  test('falling: steadily decreasing values', () => {
    expect(computeTrend([90, 80, 70, 60, 50, 40, 30, 20, 10])).toBe('falling');
  });

  test('stable: flat values', () => {
    expect(computeTrend([50, 50, 50, 50, 50, 50])).toBe('stable');
  });

  test('stable: small variation within 10% threshold', () => {
    expect(computeTrend([100, 102, 99, 101, 100, 98, 101])).toBe('stable');
  });

  test('stable: single value', () => {
    expect(computeTrend([42])).toBe('stable');
  });

  test('stable: empty array', () => {
    expect(computeTrend([])).toBe('stable');
  });

  test('rising: spike at end', () => {
    expect(computeTrend([10, 10, 10, 10, 50, 80, 120])).toBe('rising');
  });

  test('falling: crash at end', () => {
    expect(computeTrend([100, 100, 100, 100, 20, 5, 1])).toBe('falling');
  });
});

// ── resolveOwnership ──────────────────────────────────────────────────────────

describe('resolveOwnership', () => {
  test('resolves owner from lowercase tag', () => {
    expect(resolveOwnership({owner: 'payments-team'}).owner).toBe(
      'payments-team',
    );
  });

  test('resolves owner from capitalized Owner tag', () => {
    expect(resolveOwnership({Owner: 'platform-team'}).owner).toBe(
      'platform-team',
    );
  });

  test('resolves owner from team tag', () => {
    expect(resolveOwnership({team: 'sre'}).owner).toBe('sre');
  });

  test('resolves environment from environment tag', () => {
    expect(resolveOwnership({environment: 'production'}).environment).toBe(
      'production',
    );
  });

  test('resolves environment from env tag', () => {
    expect(resolveOwnership({env: 'staging'}).environment).toBe('staging');
  });

  test('resolves environment case-insensitively', () => {
    expect(resolveOwnership({Environment: 'prod'}).environment).toBe('prod');
  });

  test('resolves application from app tag', () => {
    expect(resolveOwnership({app: 'checkout-api'}).application).toBe(
      'checkout-api',
    );
  });

  test('resolves application from Application tag', () => {
    expect(resolveOwnership({Application: 'my-service'}).application).toBe(
      'my-service',
    );
  });

  test('returns all null for empty tags', () => {
    expect(resolveOwnership({})).toEqual({
      owner: null,
      environment: null,
      application: null,
    });
  });

  test('resolves all three from a full tag set', () => {
    const result = resolveOwnership({
      owner: 'payments-team',
      environment: 'production',
      application: 'checkout-api',
      'autoalarm:enabled': 'true',
    });
    expect(result).toEqual({
      owner: 'payments-team',
      environment: 'production',
      application: 'checkout-api',
    });
  });
});

// ── resolveRunbookUrl ─────────────────────────────────────────────────────────

describe('resolveRunbookUrl', () => {
  test('returns URL from autoalarm:runbook-url tag', () => {
    expect(
      resolveRunbookUrl(
        {'autoalarm:runbook-url': 'https://wiki.internal/runbooks/rds'},
        'RDS',
        'CPUUtilization',
      ),
    ).toBe('https://wiki.internal/runbooks/rds');
  });

  test('returns null when no tag and no static mapping', () => {
    expect(resolveRunbookUrl({}, 'RDS', 'CPUUtilization')).toBeNull();
  });

  test('returns null for unrelated tags', () => {
    expect(
      resolveRunbookUrl({owner: 'team-a', environment: 'prod'}, 'EC2', 'CPUUtilization'),
    ).toBeNull();
  });
});

// ── resolveDashboardUrl ───────────────────────────────────────────────────────

describe('resolveDashboardUrl', () => {
  test('returns URL from autoalarm:dashboard-url tag', () => {
    expect(
      resolveDashboardUrl(
        {'autoalarm:dashboard-url': 'https://grafana.internal/d/rds?var=db1'},
        'RDS',
        'db1',
      ),
    ).toBe('https://grafana.internal/d/rds?var=db1');
  });

  test('returns null when no tag and no matching template in current env', () => {
    // DASHBOARD_TEMPLATES is '{}' in this test environment (ESM hoisting means
    // env vars set above cannot affect module-level constants at import time).
    expect(resolveDashboardUrl({}, 'EC2', 'i-0abc123')).toBeNull();
    expect(resolveDashboardUrl({}, 'RDS', 'db1')).toBeNull();
  });
});

// ── getDimensions ─────────────────────────────────────────────────────────────

describe('getDimensions', () => {
  const cases: [string, string][] = [
    ['EC2', 'InstanceId'],
    ['RDS', 'DBInstanceIdentifier'],
    ['ALB', 'LoadBalancer'],
    ['SQS', 'QueueName'],
    ['OPENSEARCH', 'DomainName'],
    ['ECS', 'ServiceName'],
    ['CLOUDFRONT', 'DistributionId'],
    ['SFN', 'StateMachineArn'],
  ];

  test.each(cases)(
    '%s maps to dimension name %s',
    (service, expectedDimName) => {
      const dims = getDimensions(service, 'my-resource');
      expect(dims).toHaveLength(1);
      expect(dims[0].Name).toBe(expectedDimName);
      expect(dims[0].Value).toBe('my-resource');
    },
  );

  test('unknown service falls back to ResourceId', () => {
    const dims = getDimensions('UNKNOWN', 'some-id');
    expect(dims[0].Name).toBe('ResourceId');
    expect(dims[0].Value).toBe('some-id');
  });
});

// ── buildAlarmConsoleLink ─────────────────────────────────────────────────────

describe('buildAlarmConsoleLink', () => {
  test('builds correct URL', () => {
    const url = buildAlarmConsoleLink(
      'us-east-1',
      'AutoAlarm-RDS-db1-CPUUtilization-Critical',
    );
    expect(url).toContain('us-east-1.console.aws.amazon.com');
    expect(url).toContain('#alarmsV2:alarm/');
    expect(url).toContain('AutoAlarm-RDS-db1-CPUUtilization-Critical');
  });

  test('URL-encodes alarm name with special characters', () => {
    const url = buildAlarmConsoleLink(
      'us-east-1',
      'AutoAlarm-ALB-app/my-alb/123-Warning',
    );
    expect(url).toContain('%2F'); // encoded /
  });
});

// ── buildCloudTrailLink ───────────────────────────────────────────────────────

describe('buildCloudTrailLink', () => {
  test('builds correct CloudTrail URL', () => {
    const url = buildCloudTrailLink('us-east-1', 'db1');
    expect(url).toContain('cloudtrailv2');
    expect(url).toContain('region=us-east-1');
    expect(url).toContain('ResourceName=db1');
  });
});

// ── buildFallbackSummary ──────────────────────────────────────────────────────

describe('buildFallbackSummary', () => {
  test('returns fallback with runbook URL in actions', () => {
    const summary = buildFallbackSummary(
      'Critical',
      'RDS',
      'db1',
      'CPUUtilization',
      'https://wiki.internal/runbooks/rds',
    );
    expect(summary.source).toBe('fallback');
    expect(summary.confidence).toBe('low');
    expect(summary.summary).toContain('Critical');
    expect(summary.summary).toContain('RDS');
    expect(summary.recommendedActions[0]).toContain(
      'https://wiki.internal/runbooks/rds',
    );
  });

  test('uses default action when no runbook URL', () => {
    const summary = buildFallbackSummary(
      'Warning',
      'EC2',
      'i-0abc123',
      'CPUUtilization',
      null,
    );
    expect(summary.recommendedActions[0]).toContain('CloudWatch console');
  });

  test('has all required fields', () => {
    const summary = buildFallbackSummary('Critical', 'RDS', 'db1', 'CPU', null);
    expect(summary).toMatchObject({
      summary: expect.any(String),
      rootCauseHypothesis: expect.any(String),
      recommendedActions: expect.arrayContaining([expect.any(String)]),
      confidence: 'low',
      source: 'fallback',
    });
  });
});

// ── handler (integration) ─────────────────────────────────────────────────────

describe('handler', () => {
  /** Minimal valid EventBridge alarm state change event */
  const makeRecord = (overrides: Record<string, unknown> = {}) => ({
    messageId: 'msg-1',
    body: JSON.stringify({
      source: 'aws.cloudwatch',
      'detail-type': 'CloudWatch Alarm State Change',
      account: '111122223333',
      region: 'us-east-1',
      time: '2026-03-30T14:23:00Z',
      detail: {
        alarmName: 'AutoAlarm-RDS-db1-CPUUtilization-Critical',
        alarmArn:
          'arn:aws:cloudwatch:us-east-1:111122223333:alarm:AutoAlarm-RDS-db1-CPUUtilization-Critical',
        state: {value: 'ALARM', reason: 'Threshold crossed', timestamp: '2026-03-30T14:23:00Z'},
        previousState: {value: 'OK'},
      },
      ...overrides,
    }),
  });

  const makeSqsEvent = (records = [makeRecord()]) => ({
    Records: records,
  });

  const setupHappyPathMocks = () => {
    // No prior idempotency record
    ddbMock.on(GetItemCommand).resolves({Item: undefined});
    ddbMock.on(PutItemCommand).resolves({});

    // Tags
    cwMock.on(ListTagsForResourceCommand).resolves({
      Tags: [
        {Key: 'owner', Value: 'payments-team'},
        {Key: 'environment', Value: 'production'},
        {Key: 'autoalarm:runbook-url', Value: 'https://wiki.internal/rds'},
      ],
    });

    // Correlated metrics
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        {Id: 'm0', Label: 'DatabaseConnections', Values: [45, 89, 156, 201]},
        {Id: 'm1', Label: 'FreeableMemory', Values: [2e9, 1e9, 5e8, 2e8]},
      ],
    });

    // Correlation window: 1 concurrent alarm
    cwMock.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [
        {AlarmName: 'AutoAlarm-RDS-db1-CPUUtilization-Critical'},
        {AlarmName: 'AutoAlarm-RDS-db1-DatabaseConnections-Warning'},
      ],
    });

    // No CloudTrail events
    // @ts-expect-error aws-sdk-client-mock version mismatch
    ctMock.on(LookupEventsCommand).resolves({Events: []});

    // SNS publish succeeds
    // @ts-expect-error aws-sdk-client-mock version mismatch
    snsMock.on(PublishCommand).resolves({MessageId: 'sns-msg-1'});
  };

  test('successfully enriches and publishes a valid alarm event', async () => {
    setupHappyPathMocks();
    const result = await handler(makeSqsEvent() as never);
    expect(result.batchItemFailures).toHaveLength(0);
    expect(snsMock.calls()).toHaveLength(1);
  });

  test('publishes with correlationWindow when concurrent alarms exist', async () => {
    setupHappyPathMocks();
    await handler(makeSqsEvent() as never);

    const publishCall = snsMock.calls()[0];
    const message = JSON.parse(
      (publishCall.args[0].input as {Message: string}).Message,
    );
    expect(message.enrichment.correlationWindow).toBeDefined();
    expect(message.enrichment.correlationWindow.concurrentAlarms).toBe(2);
  });

  test('includes resource tags and ownership in payload', async () => {
    setupHappyPathMocks();
    await handler(makeSqsEvent() as never);

    const publishCall = snsMock.calls()[0];
    const message = JSON.parse(
      (publishCall.args[0].input as {Message: string}).Message,
    );
    expect(message.resource.owner).toBe('payments-team');
    expect(message.resource.environment).toBe('production');
    expect(message.context.runbookUrl).toBe('https://wiki.internal/rds');
  });

  test('skips duplicate event (idempotency check returns existing record)', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {idempotencyKey: {S: 'already-processed'}},
    });

    const result = await handler(makeSqsEvent() as never);
    expect(result.batchItemFailures).toHaveLength(0);
    // SNS should NOT be called for a duplicate
    expect(snsMock.calls()).toHaveLength(0);
  });

  test('sends unparseable alarm name to DLQ and publishes degraded SNS notification', async () => {
    ddbMock.on(GetItemCommand).resolves({Item: undefined});
    // @ts-expect-error aws-sdk-client-mock version mismatch
    snsMock.on(PublishCommand).resolves({MessageId: 'degraded-msg'});

    const record = makeRecord();
    // Put an un-parseable alarm name in the event
    const body = JSON.parse(record.body);
    body.detail.alarmName = 'NotAnAutoAlarm';
    record.body = JSON.stringify(body);

    const result = await handler(makeSqsEvent([record]) as never);
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe('msg-1');
    // Degraded notification must be published
    expect(snsMock.calls()).toHaveLength(1);
    const published = JSON.parse(
      (snsMock.calls()[0].args[0].input as {Message: string}).Message,
    );
    expect(published.alarm.name).toBe('NotAnAutoAlarm');
    expect(published.enrichment.parseError).toBe('alarm_name_unparseable');
    expect(published.resource.service).toBe('unknown');
  });

  test('sends invalid JSON body to DLQ without SNS notification', async () => {
    const result = await handler({
      Records: [{messageId: 'bad-msg', body: 'not-json'}],
    } as never);
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe('bad-msg');
    // Cannot extract anything useful from malformed JSON — no SNS
    expect(snsMock.calls()).toHaveLength(0);
  });

  test('sends schema-invalid event to DLQ and publishes degraded SNS notification when alarm info extractable', async () => {
    // @ts-expect-error aws-sdk-client-mock version mismatch
    snsMock.on(PublishCommand).resolves({MessageId: 'degraded-schema'});
    const result = await handler({
      Records: [
        {
          messageId: 'schema-fail',
          body: JSON.stringify({
            source: 'aws.s3', // wrong source — fails schema
            'detail-type': 'CloudWatch Alarm State Change',
            account: '111122223333',
            region: 'us-east-1',
            detail: {
              alarmName: 'AutoAlarm-RDS-db1-CPUUtilization-Critical',
              state: {value: 'ALARM'},
            },
          }),
        },
      ],
    } as never);
    expect(result.batchItemFailures).toHaveLength(1);
    // Degraded notification published because account/region/alarmName are present
    expect(snsMock.calls()).toHaveLength(1);
    const published = JSON.parse(
      (snsMock.calls()[0].args[0].input as {Message: string}).Message,
    );
    expect(published.alarm.name).toBe('AutoAlarm-RDS-db1-CPUUtilization-Critical');
    expect(published.enrichment.parseError).toBe('schema_validation_failed');
  });

  test('sends schema-invalid event to DLQ without SNS when alarm info not extractable', async () => {
    const result = await handler({
      Records: [
        {
          messageId: 'schema-fail-no-info',
          body: JSON.stringify({foo: 'bar'}), // no account/region/alarmName
        },
      ],
    } as never);
    expect(result.batchItemFailures).toHaveLength(1);
    // No account/region available — skip SNS
    expect(snsMock.calls()).toHaveLength(0);
  });

  test('degrades gracefully when CloudWatch tags call fails', async () => {
    cwMock.on(ListTagsForResourceCommand).rejects(new Error('Access denied'));
    cwMock.on(GetMetricDataCommand).resolves({MetricDataResults: []});
    cwMock.on(DescribeAlarmsCommand).resolves({MetricAlarms: []});
    // @ts-expect-error aws-sdk-client-mock version mismatch
    ctMock.on(LookupEventsCommand).resolves({Events: []});
    ddbMock.on(GetItemCommand).resolves({Item: undefined});
    ddbMock.on(PutItemCommand).resolves({});
    // @ts-expect-error aws-sdk-client-mock version mismatch
    snsMock.on(PublishCommand).resolves({MessageId: 'sns-degraded'});

    const result = await handler(makeSqsEvent() as never);
    // Still publishes — no failure
    expect(result.batchItemFailures).toHaveLength(0);
    expect(snsMock.calls()).toHaveLength(1);

    const message = JSON.parse(
      (snsMock.calls()[0].args[0].input as {Message: string}).Message,
    );
    // Tags empty, ownership null
    expect(message.resource.tags).toEqual({});
    expect(message.resource.owner).toBeNull();
  });

  test('processes multiple records independently', async () => {
    const makeRecordForAlarm = (alarmName: string, id: string) => {
      const r = makeRecord();
      const body = JSON.parse(r.body);
      body.detail.alarmName = alarmName;
      body.detail.alarmArn = `arn:aws:cloudwatch:us-east-1:111122223333:alarm:${alarmName}`;
      return {...r, messageId: id, body: JSON.stringify(body)};
    };

    setupHappyPathMocks();
    // Override DDB: second record is a duplicate
    ddbMock.reset();
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({Item: undefined}) // first: new
      .resolvesOnce({Item: {idempotencyKey: {S: 'dup'}}}); // second: duplicate
    ddbMock.on(PutItemCommand).resolves({});

    const result = await handler(
      makeSqsEvent([
        makeRecordForAlarm('AutoAlarm-RDS-db1-CPUUtilization-Critical', 'msg-a'),
        makeRecordForAlarm('AutoAlarm-RDS-db2-FreeableMemory-Warning', 'msg-b'),
      ]) as never,
    );

    expect(result.batchItemFailures).toHaveLength(0);
    // Only first record triggers SNS publish (second is duplicate)
    expect(snsMock.calls()).toHaveLength(1);
  });
});
