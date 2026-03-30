/**
 * Tests for enrichment-schemas.mts Valibot validation.
 *
 * Run individually:
 *   npx vitest run ./src/types/enrichment-schemas.test.mts
 */
import {test, expect, describe} from 'vitest';
import {safeParse} from 'valibot';
import {AlarmStateChangeEventSchema} from './enrichment-schemas.mjs';

/** Minimal valid alarm state change event */
const validEvent = () => ({
  source: 'aws.cloudwatch' as const,
  'detail-type': 'CloudWatch Alarm State Change' as const,
  account: '111122223333',
  region: 'us-east-1',
  time: '2026-03-30T14:23:00Z',
  detail: {
    alarmName: 'AutoAlarm-RDS-db1-CPUUtilization-Critical',
    alarmArn:
      'arn:aws:cloudwatch:us-east-1:111122223333:alarm:AutoAlarm-RDS-db1-CPUUtilization-Critical',
    state: {
      value: 'ALARM' as const,
      reason: 'Threshold Crossed',
      timestamp: '2026-03-30T14:23:00Z',
    },
    previousState: {value: 'OK' as const},
  },
});

describe('AlarmStateChangeEventSchema', () => {
  // ── Valid cases ─────────────────────────────────────────────────────────────

  test('accepts a minimal valid event', () => {
    const result = safeParse(AlarmStateChangeEventSchema, validEvent());
    expect(result.success).toBe(true);
  });

  test('accepts event with optional fields omitted (time, id)', () => {
    const event = validEvent();
    // @ts-expect-error — removing optional field for test
    delete event.time;
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(true);
  });

  test('accepts event with previousState omitted', () => {
    const event = validEvent();
    // @ts-expect-error
    delete event.detail.previousState;
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(true);
  });

  test('accepts OK state value', () => {
    const event = validEvent();
    // @ts-expect-error
    event.detail.state.value = 'OK';
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(true);
  });

  test('accepts INSUFFICIENT_DATA state value', () => {
    const event = validEvent();
    // @ts-expect-error
    event.detail.state.value = 'INSUFFICIENT_DATA';
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(true);
  });

  test('accepts event with configuration field', () => {
    const event = {
      ...validEvent(),
      detail: {
        ...validEvent().detail,
        configuration: {
          description: 'Test alarm',
          metrics: [{id: 'm1', metricStat: {stat: 'Average'}}],
        },
      },
    };
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(true);
  });

  // ── Wrong source ────────────────────────────────────────────────────────────

  test('rejects wrong source', () => {
    const event = {...validEvent(), source: 'aws.s3'};
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(false);
  });

  test('rejects missing source', () => {
    const event = validEvent() as Record<string, unknown>;
    delete event['source'];
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(false);
  });

  // ── Wrong detail-type ───────────────────────────────────────────────────────

  test('rejects wrong detail-type', () => {
    const event = {
      ...validEvent(),
      'detail-type': 'S3 Object Created',
    };
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(false);
  });

  test('rejects missing detail-type', () => {
    const event = validEvent() as Record<string, unknown>;
    delete event['detail-type'];
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(false);
  });

  // ── Missing required fields ─────────────────────────────────────────────────

  test('rejects missing account', () => {
    const event = validEvent() as Record<string, unknown>;
    delete event['account'];
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(false);
  });

  test('rejects missing region', () => {
    const event = validEvent() as Record<string, unknown>;
    delete event['region'];
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(false);
  });

  test('rejects missing detail', () => {
    const event = validEvent() as Record<string, unknown>;
    delete event['detail'];
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(false);
  });

  // ── alarmName validation ────────────────────────────────────────────────────

  test('rejects missing alarmName', () => {
    const event = validEvent();
    // @ts-expect-error
    delete event.detail.alarmName;
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(false);
  });

  test('rejects empty alarmName', () => {
    const event = {
      ...validEvent(),
      detail: {...validEvent().detail, alarmName: ''},
    };
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(false);
  });

  // ── state validation ────────────────────────────────────────────────────────

  test('rejects missing state', () => {
    const event = validEvent();
    // @ts-expect-error
    delete event.detail.state;
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(false);
  });

  test('rejects invalid state value', () => {
    const event = {
      ...validEvent(),
      detail: {
        ...validEvent().detail,
        state: {value: 'UNKNOWN_STATE'},
      },
    };
    const result = safeParse(AlarmStateChangeEventSchema, event);
    expect(result.success).toBe(false);
  });

  test('rejects non-object body', () => {
    expect(safeParse(AlarmStateChangeEventSchema, null).success).toBe(false);
    expect(safeParse(AlarmStateChangeEventSchema, 'string').success).toBe(
      false,
    );
    expect(safeParse(AlarmStateChangeEventSchema, 42).success).toBe(false);
    expect(safeParse(AlarmStateChangeEventSchema, []).success).toBe(false);
  });

  // ── Output shape ────────────────────────────────────────────────────────────

  test('output has correct types on success', () => {
    const result = safeParse(AlarmStateChangeEventSchema, validEvent());
    expect(result.success).toBe(true);
    if (!result.success) return;

    const out = result.output;
    expect(typeof out.account).toBe('string');
    expect(typeof out.region).toBe('string');
    expect(typeof out.detail.alarmName).toBe('string');
    expect(out.detail.state.value).toBe('ALARM');
  });
});
