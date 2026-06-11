import {test, expect, describe} from 'vitest';
import {filterAlarmsToDelete, findArnInEvent} from './service-helpers.mjs';
import {buildExpectedAlarmNames} from './alarm-tools.mjs';
import {SQS_CONFIGS} from '../_index.mjs';

// Use the following to run tests individually:
// npx vitest run ./alarm-configs/utils/service-helpers.test.mts

describe('filterAlarmsToDelete', () => {
  test('deletes only expected alarms that are not kept', () => {
    const existing = [
      'AutoAlarm-SQS-orders-NumberOfMessagesSent-Warning',
      'AutoAlarm-SQS-orders-NumberOfMessagesSent-Critical',
      'AutoAlarm-SQS-orders-ApproximateAgeOfOldestMessage-Warning',
    ];
    const expected = new Set(existing);
    const keep = new Set(['AutoAlarm-SQS-orders-NumberOfMessagesSent-Warning']);

    expect(filterAlarmsToDelete(existing, expected, keep)).toEqual([
      'AutoAlarm-SQS-orders-NumberOfMessagesSent-Critical',
      'AutoAlarm-SQS-orders-ApproximateAgeOfOldestMessage-Warning',
    ]);
  });

  test('never deletes alarms outside the expected names (prefix collision)', () => {
    // 'orders' is a prefix of 'orders-dlq', so the AlarmNamePrefix fetch for
    // 'orders' can return the dlq queue's alarms. They must never be deleted.
    const existing = [
      'AutoAlarm-SQS-orders-NumberOfMessagesSent-Critical',
      'AutoAlarm-SQS-orders-dlq-NumberOfMessagesSent-Critical',
    ];
    const expected = new Set([
      'AutoAlarm-SQS-orders-NumberOfMessagesSent-Critical',
    ]);
    const keep = new Set<string>();

    expect(filterAlarmsToDelete(existing, expected, keep)).toEqual([
      'AutoAlarm-SQS-orders-NumberOfMessagesSent-Critical',
    ]);
  });

  test('returns an empty array when everything is kept', () => {
    const existing = ['AutoAlarm-SQS-orders-NumberOfMessagesSent-Warning'];
    const expected = new Set(existing);
    const keep = new Set(existing);

    expect(filterAlarmsToDelete(existing, expected, keep)).toEqual([]);
  });

  test('works against names produced by buildExpectedAlarmNames', () => {
    const expected = buildExpectedAlarmNames('SQS', 'orders', SQS_CONFIGS);

    // Every expected name follows the AutoAlarm-SQS-orders- prefix format and
    // both classifications are present per config.
    expect(expected.size).toBe(SQS_CONFIGS.length * 2);
    for (const name of expected) {
      expect(name.startsWith('AutoAlarm-SQS-orders-')).toBe(true);
    }

    // A fetched alarm belonging to another queue is filtered out even when it
    // shares the prefix; expected alarms not kept are returned for deletion.
    const someExpected = [...expected].slice(0, 3);
    const existing = [
      ...someExpected,
      'AutoAlarm-SQS-orders-dlq-NumberOfMessagesSent-Critical',
    ];
    expect(
      filterAlarmsToDelete(existing, expected, new Set([someExpected[0]])),
    ).toEqual(someExpected.slice(1));
  });
});

describe('findArnInEvent', () => {
  test('extracts an ARN from a JSON-serializable event object', () => {
    const event = {
      detail: {
        responseElements: {
          dBInstanceArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb',
        },
      },
    };
    expect(findArnInEvent(event, 'arn:aws:rds')).toBe(
      'arn:aws:rds:us-west-2:123456789012:db:mydb',
    );
  });

  test('extracts an ARN from a pre-serialized event body string', () => {
    const body = JSON.stringify({
      resources: ['arn:aws:logs:us-east-1:123456789012:log-group:/my/group'],
    });
    expect(findArnInEvent(body, 'arn:aws:logs')).toBe(
      'arn:aws:logs:us-east-1:123456789012:log-group:/my/group',
    );
  });

  test('returns the first match when multiple ARNs are present', () => {
    const event = {
      first: 'arn:aws:rds:us-west-2:123456789012:db:first-db',
      second: 'arn:aws:rds:us-west-2:123456789012:db:second-db',
    };
    expect(findArnInEvent(event, 'arn:aws:rds')).toBe(
      'arn:aws:rds:us-west-2:123456789012:db:first-db',
    );
  });

  test('returns an empty string when no ARN with the prefix exists', () => {
    expect(findArnInEvent({foo: 'bar'}, 'arn:aws:rds')).toBe('');
  });
});
