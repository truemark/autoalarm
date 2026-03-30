/**
 * Valibot schemas for validating EventBridge alarm state change payloads
 * that arrive in the enrichment Lambda via SQS.
 */
import {
  array,
  check,
  literal,
  object,
  optional,
  pipe,
  string,
  union,
  unknown as unknownValue,
  type InferOutput,
} from 'valibot';

const AlarmStateSchema = object({
  value: union([
    literal('ALARM'),
    literal('OK'),
    literal('INSUFFICIENT_DATA'),
  ]),
  reason: optional(string()),
  timestamp: optional(string()),
});

const AlarmDetailSchema = object({
  alarmName: pipe(
    string(),
    check((v) => v.length > 0, 'alarmName must not be empty'),
  ),
  alarmArn: optional(string()),
  state: AlarmStateSchema,
  previousState: optional(AlarmStateSchema),
  configuration: optional(
    object({
      description: optional(string()),
      metrics: optional(array(unknownValue())),
    }),
  ),
});

/**
 * Schema for a CloudWatch Alarm State Change event forwarded via EventBridge → SQS.
 */
export const AlarmStateChangeEventSchema = object({
  source: literal('aws.cloudwatch'),
  'detail-type': literal('CloudWatch Alarm State Change'),
  account: string(),
  region: string(),
  time: optional(string()),
  id: optional(string()),
  detail: AlarmDetailSchema,
});

export type AlarmStateChangeEvent = InferOutput<
  typeof AlarmStateChangeEventSchema
>;
