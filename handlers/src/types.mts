import {SQSBatchItemFailure, SQSRecord} from 'aws-lambda';
import {Rule} from 'aws-cdk-lib/aws-events';
import {EventPatterns} from './enums.mjs';
import {ServiceProcessor} from './service-processor.mjs';

// Type definitions for autoalarm

export type ValidEC2States =
  | 'running'
  //| 'pending'
  //| 'stopped'
  //| 'stopping'
  //| 'shutting-down'
  | 'terminated';

export type TagArray = {[key: string]: string}[];

export interface EC2AlarmManagerObject {
  instanceID: string;
  tags: Tag;
  state: ValidEC2States;
  ec2Metadata?: {platform: string | null; privateIP: string | null};
}

export interface Tag {
  [key: string]: string;
}

export type EC2AlarmManagerArray = EC2AlarmManagerObject[];

export interface Dimension {
  Name: string;
  Value: string;
}

//This is a type that is used to define the contents of event bridge rules in service-eventbridge-construct.ts
export type RuleObject = {
  [ruleName: string]: Rule;
};

/**
 * Represents a supported AWS service type in the AutoAlarm system.
 *
 * This is a mapped type that extracts the keys from the EventPatterns enum,
 * allowing us to maintain a single source of truth for supported services.
 * Using this type ensures type safety when referring to service types throughout
 * the codebase, particularly in processor registration and message routing.
 *
 * @example
 * // Valid service types might include:
 * // 'ec2', 'sqs', 'rds', 'alb', etc.
 */
export type ServiceType = keyof typeof EventPatterns;

/**
 * Represents an AWS ARN pattern used to match and identify resources for a specific service.
 *
 * This type extracts the string values from the EventPatterns enum, ensuring
 * that parsing patterns always match their corresponding service definition.
 * Used when searching for service identifiers in event messages and for
 * pattern matching during record categorization.
 *
 * @example
 * // Example pattern: 'arn:aws:sqs:'
 */
export type EventParsingPattern =
  (typeof EventPatterns)[keyof typeof EventPatterns];

/**
 * Constructor interface for service processor classes.
 *
 * This interface defines the expected constructor signature for all processor
 * implementations, allowing us to store, reference, and instantiate processor
 * classes without using type assertions. It creates a contract that all
 * concrete processors must follow - accepting an array of SQS records during
 * instantiation and returning a ServiceProcessor instance.
 *
 * @template T - The specific ServiceProcessor subclass being constructed
 */
export interface ProcessorConstructor {
  /**
   * Constructs a new ServiceProcessor instance
   * @param records - The SQS records to be processed by this processor
   * @returns A new ServiceProcessor instance
   */
  new (records: SQSRecord[]): ServiceProcessor;
}

/**
 * Configuration properties for registering a service processor.
 *
 * Used when registering processors with the ProcessorRegistry, this type
 * encapsulates all the information needed to properly categorize and instantiate
 * a processor for a specific AWS service.
 *
 * @property service - The AWS service type identifier. Defined in the ServiceType type, which maps to the keys of the EventPatterns enum.
 * @property serviceProcessor - The processor class constructor
 * @property eventParsingPattern - Custom ARN pattern for service detection as defined in the EventPatterns enum
 */
export type ServiceProcessorRegisterProps = {
  /** The AWS service type this processor handles */
  service: ServiceType;

  /** The processor class constructor */
  serviceProcessor: ProcessorConstructor;

  /** Pattern that matches ARNs for this service, used for event parsing and derived from EventPatterns Enum*/
  eventParsingPattern: EventParsingPattern;
};

/**
 * Response type for batch processing operations containing failed items.
 *
 * Used throughout the processing pipeline to track and aggregate failures,
 * this type maintains both the standardized SQS batch failure format
 * required by AWS Lambda and the original record bodies for detailed
 * error logging
 *
 * @property batchItemFailures - Array of failure objects with message IDs for AWS Lambda
 * @property batchItemBodies - The original SQS records that failed processing
 */
export type SQSFailureResponse = {
  /**
   * Array of failure objects with message IDs.
   * This is the format expected by AWS Lambda's batch response.
   */
  batchItemFailures: SQSBatchItemFailure[];

  /**
   * The original SQS records that failed processing.
   * Used for detailed error reporting and diagnostics.
   */
  batchItemBodies: SQSRecord[];
};

export interface PathMetrics {
  [path: string]: Dimension[];
}

//for prometheus rule groups in NameSpaces
export interface RuleGroup {
  name: string;
  rules: PrometheusRule[];
}

//for prometheus rules in rule groups
export interface PrometheusRule {
  alert: string;
  expr: string;
  for?: string;
  labels?: {
    severity: string;
    [key: string]: string;
  };
  annotations?: {
    summary: string;
    description: string;
    [key: string]: string;
  };
}

//Prometheus Alarm Config

export interface PrometheusAlarmConfig {
  instanceId: string; // ID of the instance
  type: string; // The type or classification of the alarm
  alarmName: string; // The name of the alarm
  alarmQuery: string; // The query used for the alarm
  duration: string; // The duration of the alarm, in "Xm" format
  severityType: string; // The severity of the alarm
}

export type PrometheusAlarmConfigArray = PrometheusAlarmConfig[];

//for prometheus namespace details when populating the rule groups
export interface NamespaceDetails {
  groups: RuleGroup[];
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
