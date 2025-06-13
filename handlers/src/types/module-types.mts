// Type definitions for autoalarm service modules

import {SQSRecord} from 'aws-lambda';

export interface EC2AlarmManagerObject {
  instanceID: string;
  tags: Tag;
  state: string;
  ec2Metadata?: {platform: string | null; privateIP: string | null};
}

export type EC2AlarmManagerArray = EC2AlarmManagerObject[];

export interface Dimension {
  Name: string;
  Value: string;
}

export interface PathMetrics {
  [path: string]: Dimension[];
}

export type LoadBalancerIdentifiers = {
  LBType: 'app' | 'net' | null;
  LBName: string | null;
};

export interface AnomalyAlarmProps {
  evaluationPeriods: number;
  period: number;
  extendedStatistic: string;
}

/**
 * Interface for the result of a service module operation.
 * {template Data} - Generic type for various results on a function by function basis.
 */
export interface AlarmUpdateResult<Data = undefined> {
  isSuccess: boolean;
  res: Error | string;
  data?: Data;
}

/**
 * Tags come on various interfaces. Capture known object shapes here for use
 * across autoalarm service modules.
 */
export interface Tag extends Record<string, string> {}
export type TagsObject = Tag | Tag[] | string[]; // for events with tag keys only

/**
 * Used as a unified interface for alarm update options based on event type and
 * required tags for processing
 * @template T - A boolean that determines if tags are required in the options
 * based off if the event type contains tags with keys and values or just a list of strings.
 * this should be EventParseResult.hasTags property @see EventParseResult in handlers/src/types/event-parse-types.mts
 */
export interface AlarmUpdateOptions<T extends boolean> {
  engine: string;
  hostID: string;
  mode: {
    eventType: 'destroyed' | 'created' | 'disabled' | 'tagged' | 'untagged';
    tags: T extends true ? TagsObject : undefined;
  };
}
