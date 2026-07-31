import {test, expect, describe, afterEach, beforeEach, vi} from 'vitest';
import {
  ALARM_IDENTITY_RESOURCE_ID_TAG,
  ALARM_IDENTITY_SERVICE_TAG,
  buildAlarmArn,
  buildAlarmIdentityTags,
  handleStaticAlarms,
} from './alarm-tools.mjs';
import {
  CloudWatchClient,
  PutMetricAlarmCommand,
  type PutMetricAlarmCommandInput,
} from '@aws-sdk/client-cloudwatch';
import {TreatMissingData} from 'aws-cdk-lib/aws-cloudwatch';
import {parseMetricAlarmOptions} from './alarm-config.mjs';
import {MetricAlarmConfig} from '../../types/index.mjs';

// Use the following to run tests individually:
// npx vitest run ./alarm-configs/utils/alarm-tools.test.mts

describe('buildAlarmIdentityTags', () => {
  test('builds the service and resource-id identity tags verbatim', () => {
    expect(buildAlarmIdentityTags('SQS', 'orders')).toEqual([
      {Key: ALARM_IDENTITY_SERVICE_TAG, Value: 'SQS'},
      {Key: ALARM_IDENTITY_RESOURCE_ID_TAG, Value: 'orders'},
    ]);
  });

  test('stores ARN identifiers unmodified so the tag lookup matches', () => {
    const arn = 'arn:aws:states:us-west-2:123456789012:stateMachine:my-machine';
    const tags = buildAlarmIdentityTags('SFN', arn);
    expect(tags).toContainEqual({
      Key: ALARM_IDENTITY_RESOURCE_ID_TAG,
      Value: arn,
    });
  });

  test('does not change the case of the service label', () => {
    // The tag value must be exactly what the reconcile lookup queries with;
    // buildAlarmName uppercases the service for alarm names, but identity
    // tags use the value as passed.
    expect(buildAlarmIdentityTags('RDSCluster', 'my-cluster')[0]).toEqual({
      Key: ALARM_IDENTITY_SERVICE_TAG,
      Value: 'RDSCluster',
    });
  });
});

describe('buildAlarmArn', () => {
  const originalRegion = process.env.AWS_REGION;
  const originalAcctId = process.env.ACCT_ID;

  beforeEach(() => {
    process.env.AWS_REGION = 'us-west-2';
    process.env.ACCT_ID = '123456789012';
  });

  afterEach(() => {
    if (originalRegion === undefined) {
      delete process.env.AWS_REGION;
    } else {
      process.env.AWS_REGION = originalRegion;
    }
    if (originalAcctId === undefined) {
      delete process.env.ACCT_ID;
    } else {
      process.env.ACCT_ID = originalAcctId;
    }
  });

  test('builds the alarm ARN from AWS_REGION and ACCT_ID', () => {
    expect(
      buildAlarmArn('AutoAlarm-SQS-orders-NumberOfMessagesSent-Critical'),
    ).toBe(
      'arn:aws:cloudwatch:us-west-2:123456789012:alarm:AutoAlarm-SQS-orders-NumberOfMessagesSent-Critical',
    );
  });

  test('returns undefined when ACCT_ID is not set', () => {
    delete process.env.ACCT_ID;
    expect(buildAlarmArn('AutoAlarm-SQS-orders-foo-Warning')).toBeUndefined();
  });

  test('returns undefined when AWS_REGION is not set', () => {
    delete process.env.AWS_REGION;
    expect(buildAlarmArn('AutoAlarm-SQS-orders-foo-Warning')).toBeUndefined();
  });
});

/**
 * The CloudWatch PutMetricAlarm contract.
 *
 * These constraints are enforced on the CloudWatch path (not in the shared tag
 * parser, which the Prometheus rule path also uses), so they are asserted here
 * against the input actually handed to the API. Each violation below is a
 * ValidationError from CloudWatch, i.e. an alarm that silently fails to exist.
 */
describe('PutMetricAlarm contract', () => {
  // Spying on the client prototype rather than using aws-sdk-client-mock: the
  // pinned v1 of that library resolves an older @smithy/types than the
  // CloudWatch client, and the two are not assignable to each other.
  const sendSpy = vi.spyOn(CloudWatchClient.prototype, 'send');

  const config: MetricAlarmConfig = {
    tagKey: 'cpu',
    metricName: 'CPUUtilization',
    metricNamespace: 'AWS/EC2',
    defaultCreate: true,
    anomaly: false,
    defaults: {
      warningThreshold: 90,
      criticalThreshold: 95,
      period: 300,
      evaluationPeriods: 2,
      statistic: 'Average',
      dataPointsToAlarm: 2,
      comparisonOperator: 'GreaterThanThreshold',
      missingDataTreatment: TreatMissingData.MISSING,
    },
  };

  /** Drive the real static-alarm path and return the PutMetricAlarm inputs. */
  async function putInputsFor(
    tagValue: string,
  ): Promise<PutMetricAlarmCommandInput[]> {
    sendSpy.mockClear();
    const options = parseMetricAlarmOptions(tagValue, config.defaults);
    await handleStaticAlarms(config, 'EC2', 'i-abc123', [], options);
    // `send` is overloaded across every CloudWatch command, so the recorded
    // argument type is a union TS will not narrow by instanceof. The runtime
    // check below is what actually guarantees the type.
    const sent: unknown[] = sendSpy.mock.calls.map(([command]) => command);
    return sent
      .filter(
        (command): command is PutMetricAlarmCommand =>
          command instanceof PutMetricAlarmCommand,
      )
      .map((command) => command.input);
  }

  beforeEach(() => {
    process.env.AWS_REGION = 'us-west-2';
    process.env.ACCT_ID = '123456789012';
    // Every CloudWatch call in this path is fire-and-check-input; the response
    // body is never read, so an empty resolution is enough.
    sendSpy.mockResolvedValue({} as never);
  });

  afterEach(() => {
    sendSpy.mockClear();
  });

  test.each([
    [7, 10],
    [15, 20],
    [25, 30],
    [45, 60],
    [61, 120],
    [3599, 3600],
  ])('snaps invalid period %i up to %i', async (authored, expected) => {
    const inputs = await putInputsFor(`90/95/${authored}`);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.Period).toBe(expected);
    }
  });

  test('accepts 20 as a valid period instead of snapping it to 30', async () => {
    // 20 is explicitly valid per PutMetricAlarm; it used to become 30.
    const inputs = await putInputsFor('90/95/20');
    for (const input of inputs) {
      expect(input.Period).toBe(20);
    }
  });

  test.each([10, 20, 30, 60, 120, 300, 600, 3600])(
    'leaves valid period %i untouched',
    async (period) => {
      const inputs = await putInputsFor(`90/95/${period}/1`);
      for (const input of inputs) {
        expect(input.Period).toBe(period);
      }
    },
  );

  test('clamps DatapointsToAlarm to EvaluationPeriods', async () => {
    // dataPointsToAlarm is the M in "M out of N" and cannot exceed the N.
    const inputs = await putInputsFor('90/95/300/2/Average/5');
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.EvaluationPeriods).toBe(2);
      expect(input.DatapointsToAlarm).toBe(2);
    }
  });

  test('leaves a valid DatapointsToAlarm alone', async () => {
    const inputs = await putInputsFor('90/95/300/5/Average/3');
    for (const input of inputs) {
      expect(input.EvaluationPeriods).toBe(5);
      expect(input.DatapointsToAlarm).toBe(3);
    }
  });

  test('clamps EvaluationPeriods to the one-day window for sub-hour periods', async () => {
    // 60s x 2000 = 120,000s, over the 86,400s cap. Max N at 60s is 1440.
    const inputs = await putInputsFor('90/95/60/2000');
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.Period! * input.EvaluationPeriods!).toBeLessThanOrEqual(
        86_400,
      );
      expect(input.EvaluationPeriods).toBe(1440);
    }
  });

  test('allows a full seven-day window at an hourly period', async () => {
    // 3600s x 168 = 604,800s exactly — the seven-day maximum.
    const inputs = await putInputsFor('90/95/3600/168');
    for (const input of inputs) {
      expect(input.EvaluationPeriods).toBe(168);
    }
  });

  test('clamps a window beyond seven days at an hourly period', async () => {
    const inputs = await putInputsFor('90/95/3600/200');
    for (const input of inputs) {
      expect(input.Period! * input.EvaluationPeriods!).toBeLessThanOrEqual(
        604_800,
      );
      expect(input.EvaluationPeriods).toBe(168);
    }
  });

  test('never sends a non-finite Threshold', async () => {
    // 'Infinity' and '1e400' both yielded Infinity, which JSON-serialises to
    // null in the API call.
    for (const tagValue of ['Infinity/95', '1e400/95', '-Infinity/-Infinity']) {
      const inputs = await putInputsFor(tagValue);
      for (const input of inputs) {
        expect(Number.isFinite(input.Threshold)).toBe(true);
      }
    }
  });

  test('sends a threshold of 0 rather than dropping the alarm', async () => {
    // RDS DatabaseDeadlocks ships criticalThreshold: 0.
    const inputs = await putInputsFor('-/0');
    const thresholds = inputs.map((input) => input.Threshold);
    expect(thresholds).toContain(0);
  });
});
