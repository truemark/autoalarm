import {SQSBatchItemFailure, SQSRecord} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {ServiceProps, ServiceType, SQSFailureResponse} from './types.mjs';
import {manageEC2} from './ec2-modules.mjs';
import {parseALBEventAndCreateAlarms} from './alb-modules.mjs';
import {parseCloudFrontEventAndCreateAlarms} from './cloudfront-modules.mjs';
import {parseOSEventAndCreateAlarms} from './opensearch-modules.mjs';
import {parseRDSEventAndCreateAlarms} from './rds-modules.mjs';
import {parseRDSClusterEventAndCreateAlarms} from './rds-cluster-modules.mjs';
import {parseR53ResolverEventAndCreateAlarms} from './route53-resolver-modules.mjs';
import {parseSQSEventAndCreateAlarms} from './sqs-modules.mjs';
import {parseSFNEventAndCreateAlarms} from './step-function-modules.mjs';
import {parseTGEventAndCreateAlarms} from './targetgroup-modules.mjs';
import {parseTransitGatewayEventAndCreateAlarms} from './transit-gateway-modules.mjs';
import {parseVpnEventAndCreateAlarms} from './vpn-modules.mjs';

const log: logging.Logger = logging.getLogger('service-router');

/**
 * Helper function to search for resource identifiers in events
 * Efficiently extracts pattern matches from SQS records or string data
 * @param record SQS record or other object containing event data Best practice is to pass the records object already stringified.
 * @param searchPattern String pattern to search for
 * @param endDelimiter Character that marks the end of the pattern
 * @returns Matched string or empty string if not found
 */
export function eventSearch(
  record: SQSRecord | string,
  searchPattern: string,
  endDelimiter: string,
): string {
  let recordString: string;

  // Handle different input types
  if (typeof record === 'string') {
    // Input is already a string (pre-stringified JSON or parsed object)
    recordString = record;
  } else {
    // For SQSRecord objects
    if (record.body) {
      // For our current SQS handler use case, we want to search within the body content
      recordString = JSON.stringify(record.body);
    } else {
      // Fallback for other record types for future compatability with other object parsing if needed
      recordString = JSON.stringify(record);
    }
  }

  const startIndex = recordString.indexOf(searchPattern);
  if (startIndex === -1) {
    log
      .debug()
      .str('function', 'eventSearch')
      .str('searchPattern', searchPattern)
      .msg('Search pattern not found in record');
    return '';
  }

  const endIndex = recordString.indexOf(endDelimiter, startIndex);
  if (endIndex === -1) {
    log
      .debug()
      .str('function', 'eventSearch')
      .str('endDelimiter', endDelimiter)
      .msg('End delimiter not found in record');
    return '';
  }

  return recordString.substring(startIndex, endIndex);
}

/**
 * Abstract base class for all service processors
 * Defines the interface and common functionality that all service-specific processors must implement
 *
 * This class serves as the foundation for the processor-based architecture, enabling:
 * 1. Service-specific optimizations (like EC2 batch processing)
 * 2. Clear separation of responsibilities per service
 * 3. Consistent error handling and failure reporting
 * 4. Extensibility for new AWS services by adding new processor implementations
 *
 * In Lambda environments, processors are initialized once and maintained across warm invocations,
 * optimizing performance while maintaining clean state boundaries.
 */
export abstract class ServiceProcessor {
  protected log: logging.Logger;

  /**
   * Creates a new ServiceProcessor
   * @param serviceType The AWS service type this processor handles
   */
  constructor(protected serviceType: ServiceType) {
    this.log = logging.getLogger(`processor-${serviceType}`);
  }

  /**
   * Get the service type this processor handles
   * @returns The service type associated with this processor
   */
  getServiceType(): ServiceType {
    return this.serviceType;
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this processor can handle the record
   */
  abstract canProcess(record: SQSRecord): boolean;

  /**
   * Process a batch of records for this service type
   * @param records Array of SQS records to process
   * @returns SQS failure response containing any failed records
   */
  abstract process(records: SQSRecord[]): Promise<SQSFailureResponse>;

  /**
   * Helper method to get a stringified version of a record for searching
   * @param record SQS record to stringify
   * @returns Stringified version of the record
   */
  protected getStringifiedRecord(record: SQSRecord): string {
    // For consistency with eventSearch, we use JSON.stringify(record.body)
    return JSON.stringify(record.body);
  }

  /**
   * Helper method to search for patterns in records
   * @param record SQS record to search
   * @param pattern Pattern to search for
   * @param endDelimiter Delimiter that marks the end of the pattern
   * @returns Matched string or empty string if not found
   */
  protected searchRecord(
    record: SQSRecord,
    pattern: string,
    endDelimiter: string = '"',
  ): string {
    const stringified = this.getStringifiedRecord(record);
    return eventSearch(stringified, pattern, endDelimiter);
  }
}

/**
 * EC2-specific processor implementation
 */
export class EC2Processor extends ServiceProcessor {
  constructor() {
    super('ec2');
  }

  /**
   * Check if this processor can handle the given record
   * Identifies EC2 records while excluding VPN and Transit Gateway records
   * @param record SQS record to check
   * @returns true if this is an EC2 record (and not a VPN or Transit Gateway record)
   */
  canProcess(record: SQSRecord): boolean {
    const searchResult = this.searchRecord(record, 'arn:aws:ec2:', '"');

    // Make sure it's an EC2 record but not a VPN or Transit Gateway
    if (searchResult) {
      if (searchResult.includes('vpn') || searchResult.includes('transit')) {
        log
          .trace()
          .str('class', 'EC2Processor')
          .str('function', 'canProcess')
          .str('messageId', record.messageId)
          .msg('Skipping VPN/Transit Gateway event');
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Process a batch of EC2 records
   * Optimized for Lambda's 10-record batch size, reducing API calls by batching EC2 operations
   * @param records Array of EC2 SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];
    const ec2InstanceMap: Record<string, SQSRecord>[] = [];

    // Transform records into the format expected by manageEC2
    for (const record of records) {
      try {
        const searchResult = this.searchRecord(record, 'arn:aws:ec2:', '"');

        if (searchResult) {
          // Extract instance ID
          const instanceId = searchResult.split('/').pop();

          if (instanceId) {
            log
              .trace()
              .str('class', 'EC2Processor')
              .str('function', 'process')
              .str('messageId', record.messageId)
              .str('instanceId', instanceId)
              .msg('Adding EC2 instance to batch');

            ec2InstanceMap.push({[searchResult]: record});
          }
        }
      } catch (error) {
        this.log
          .error()
          .str('class', 'EC2Processor')
          .str('function', 'process')
          .str('messageId', record.messageId)
          .err(error)
          .msg('Error preparing EC2 event for batch processing');

        batchItemFailures.push({
          itemIdentifier: record.messageId,
        });
        batchItemBodies.push(record);
      }
    }

    // Process the batch if we have EC2 instances
    if (ec2InstanceMap.length > 0) {
      this.log
        .info()
        .str('class', 'EC2Processor')
        .str('function', 'process')
        .num('instanceIDs', ec2InstanceMap.length)
        .msg('Processing batch of EC2 instances');

      try {
        const ec2FailedRecords = await manageEC2(ec2InstanceMap);

        if (ec2FailedRecords.length > 0) {
          this.log
            .error()
            .str('class', 'EC2Processor')
            .str('function', 'process')
            .num('failedItems', ec2FailedRecords.length)
            .msg('Batch item failures found in EC2 processing');

          ec2FailedRecords.forEach((record) => {
            const messageId = record[Object.keys(record)[0]].messageId;
            batchItemFailures.push({
              itemIdentifier: messageId,
            });
            batchItemBodies.push(record[Object.keys(record)[0]]);
          });
        }
      } catch (error) {
        this.log
          .error()
          .str('class', 'EC2Processor')
          .str('function', 'process')
          .err(error)
          .msg('Unhandled error during batch EC2 processing');

        // Add all records from the batch to failures since we can't determine which ones failed
        ec2InstanceMap.forEach((record) => {
          const instanceKey = Object.keys(record)[0];
          const sqsRecord = record[instanceKey];

          batchItemFailures.push({
            itemIdentifier: sqsRecord.messageId,
          });
          batchItemBodies.push(sqsRecord);
        });
      }
    }

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * ALB processor implementation
 */
export class ALBProcessor extends ServiceProcessor {
  constructor() {
    super('alb');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is an ALB record
   */
  canProcess(record: SQSRecord): boolean {
    return (
      !!this.searchRecord(record, 'arn:aws:elasticloadbalancing:', '"') &&
      !this.searchRecord(
        record,
        'arn:aws:elasticloadbalancing:targetgroup:',
        '"',
      )
    );
  }

  /**
   * Process a batch of ALB records
   * @param records Array of ALB SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseALBEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'ALBProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing ALB record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * CloudFront processor implementation
 */
export class CloudFrontProcessor extends ServiceProcessor {
  constructor() {
    super('cloudfront');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a CloudFront record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:cloudfront:', '"');
  }

  /**
   * Process a batch of CloudFront records
   * @param records Array of CloudFront SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseCloudFrontEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'CloudFrontProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing CloudFront record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * OpenSearch processor implementation
 */
export class OpenSearchProcessor extends ServiceProcessor {
  constructor() {
    super('opensearch');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is an OpenSearch record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:es:', '"');
  }

  /**
   * Process a batch of OpenSearch records
   * @param records Array of OpenSearch SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseOSEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'OpenSearchProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing OpenSearch record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * RDS processor implementation
 */
export class RDSProcessor extends ServiceProcessor {
  constructor() {
    super('rds');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is an RDS record (non-cluster)
   */
  canProcess(record: SQSRecord): boolean {
    const isRDS = !!this.searchRecord(record, 'arn:aws:rds:', '"');
    const isCluster = !!this.searchRecord(record, 'arn:aws:rds:cluster:', '"');
    return isRDS && !isCluster;
  }

  /**
   * Process a batch of RDS records
   * @param records Array of RDS SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseRDSEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'RDSProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing RDS record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * RDS Cluster processor implementation
 */
export class RDSClusterProcessor extends ServiceProcessor {
  constructor() {
    super('rds-cluster');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is an RDS Cluster record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:rds:cluster:', '"');
  }

  /**
   * Process a batch of RDS Cluster records
   * @param records Array of RDS Cluster SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseRDSClusterEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'RDSClusterProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing RDS Cluster record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * Route53 Resolver processor implementation
 */
export class Route53ResolverProcessor extends ServiceProcessor {
  constructor() {
    super('route53-resolver');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a Route53 Resolver record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:route53resolver:', '"');
  }

  /**
   * Process a batch of Route53 Resolver records
   * @param records Array of Route53 Resolver SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseR53ResolverEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'Route53ResolverProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing Route53 Resolver record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * SQS Queue processor implementation
 */
export class SQSProcessor extends ServiceProcessor {
  constructor() {
    super('sqs');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a SQS Queue record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:sqs:', '"');
  }

  /**
   * Process a batch of SQS Queue records
   * @param records Array of SQS Queue SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseSQSEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'SQSProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing SQS Queue record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * Step Function processor implementation
 */
export class StepFunctionProcessor extends ServiceProcessor {
  constructor() {
    super('step-function');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a Step Function record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:states:', '"');
  }

  /**
   * Process a batch of Step Function records
   * @param records Array of Step Function SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseSFNEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'StepFunctionProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing Step Function record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * Target Group processor implementation
 */
export class TargetGroupProcessor extends ServiceProcessor {
  constructor() {
    super('targetgroup');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a Target Group record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(
      record,
      'arn:aws:elasticloadbalancing:targetgroup:',
      '"',
    );
  }

  /**
   * Process a batch of Target Group records
   * @param records Array of Target Group SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseTGEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'TargetGroupProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing Target Group record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * Transit Gateway processor implementation
 */
export class TransitGatewayProcessor extends ServiceProcessor {
  constructor() {
    super('transit-gateway');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a Transit Gateway record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:ec2:transit-gateway:', '"');
  }

  /**
   * Process a batch of Transit Gateway records
   * @param records Array of Transit Gateway SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseTransitGatewayEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'TransitGatewayProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing Transit Gateway record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * VPN processor implementation
 */
export class VPNProcessor extends ServiceProcessor {
  constructor() {
    super('vpn');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a VPN record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:ec2:vpn:', '"');
  }

  /**
   * Process a batch of VPN records
   * @param records Array of VPN SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseVpnEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'VPNProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing VPN record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * Registry that manages all service processors and handles routing
 */
export class ProcessorRegistry {
  private processors: ServiceProcessor[] = [];

  /**
   * Cache for storing stringified records to avoid repeated JSON processing
   * Keys are message IDs, values are the stringified record bodies
   * Cache entries are cleared after successful processing or on reset
   */
  private stringifiedCache = new Map<string, string>();

  /**
   * Create a new processor registry
   * @param serviceProps Array of service configurations (kept for backward compatibility with main-handler)
   * Although we now use specialized processor classes, we maintain this parameter
   * to ensure compatibility with existing code that calls this constructor
   */
  // TODO: Refactor main-handler.mts to not pass serviceProps once all tests pass and modules are migrated to processors
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(serviceProps: ServiceProps[]) {
    // Initialize specialized processors
    this.initializeProcessors();

    log
      .info()
      .str('class', 'ProcessorRegistry')
      .str('function', 'constructor')
      .num('processorCount', this.processors.length)
      .msg('ProcessorRegistry initialized with specialized processors');
  }

  /**
   * Reset any per-invocation state
   * Essential for Lambda warm starts to ensure clean state between invocations
   * This prevents cross-invocation data leakage and memory buildup
   */
  reset(): void {
    // Clear cache to prevent memory leaks between invocations
    this.stringifiedCache.clear();
    log
      .trace()
      .str('class', 'ProcessorRegistry')
      .str('function', 'reset')
      .msg('ProcessorRegistry state reset for new invocation');
  }

  /**
   * Remove a record from the cache once it's been processed
   * This helps manage memory usage during processing
   * @param messageId The SQS message ID to remove from cache
   */
  clearCacheEntry(messageId: string): void {
    if (this.stringifiedCache.has(messageId)) {
      this.stringifiedCache.delete(messageId);
    }
  }

  /**
   * Initialize all service processors
   * Creates specialized processor instances for each service type
   * This method is called only once per Lambda container (cold start)
   */
  private initializeProcessors(): void {
    // Initialize all specialized processors
    this.processors = [
      new EC2Processor(),
      new ALBProcessor(),
      new CloudFrontProcessor(),
      new OpenSearchProcessor(),
      new RDSProcessor(),
      new RDSClusterProcessor(),
      new Route53ResolverProcessor(),
      new SQSProcessor(),
      new StepFunctionProcessor(),
      new TargetGroupProcessor(),
      new TransitGatewayProcessor(),
      new VPNProcessor(),
    ];

    log
      .debug()
      .str('class', 'ProcessorRegistry')
      .str('function', 'initializeProcessors')
      .num('processorCount', this.processors.length)
      .msg('Initialized all specialized service processors');
  }

  /**
   * Categorize records by service type
   * Maps each SQS record to its corresponding service processor
   * Optimized for Lambda's batch size of up to 10 records
   * @param records Array of SQS records to categorize
   * @returns Object containing a map of service types to records and uncategorized records
   */
  categorizeRecords(records: SQSRecord[]): {
    serviceMap: Map<ServiceType, SQSRecord[]>;
    uncategorizedRecords: SQSRecord[];
  } {
    const serviceMap = new Map<ServiceType, SQSRecord[]>();
    const uncategorizedRecords: SQSRecord[] = [];

    // Process each record
    for (const record of records) {
      let categorized = false;

      // Try each processor
      for (const processor of this.processors) {
        if (processor.canProcess(record)) {
          // Get the service type directly from the processor
          const serviceType = processor.getServiceType();

          // Initialize array for this service if needed
          if (!serviceMap.has(serviceType)) {
            serviceMap.set(serviceType, []);
          }

          // Add record to the appropriate service category
          serviceMap.get(serviceType)!.push(record);
          categorized = true;
          break; // Stop after first match
        }
      }

      // Add to uncategorized if no processor claimed it
      if (!categorized) {
        log
          .warn()
          .str('class', 'ProcessorRegistry')
          .str('function', 'categorizeRecords')
          .str('messageId', record.messageId)
          .msg('Unable to categorize record');
        uncategorizedRecords.push(record);
      }
    }

    // Log categorization results
    log
      .info()
      .str('class', 'ProcessorRegistry')
      .str('function', 'categorizeRecords')
      .num('totalRecords', records.length)
      .num('categorizedServices', serviceMap.size)
      .num('uncategorizedRecords', uncategorizedRecords.length)
      .msg('Record categorization complete');

    // Log detailed breakdown for service distribution
    if (serviceMap.size > 0) {
      const serviceBreakdown = Array.from(serviceMap.entries())
        .map(([service, recs]) => `${service}:${recs.length}`)
        .join(', ');

      log
        .debug()
        .str('class', 'ProcessorRegistry')
        .str('function', 'categorizeRecords')
        .str('serviceBreakdown', serviceBreakdown)
        .msg('Service categorization breakdown');
    }

    return {serviceMap, uncategorizedRecords};
  }

  /**
   * Process records by service type
   * Efficiently executes service-specific processing in parallel
   * Optimized for Lambda execution environment with batch processing
   * @param serviceMap Map of service types to arrays of records
   * @returns SQS failure response containing any failed records
   */
  async processRecordsByService(
    serviceMap: Map<ServiceType, SQSRecord[]>,
  ): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    // Process each service's records in parallel
    const results = await Promise.allSettled(
      Array.from(serviceMap.entries()).map(async ([serviceType, records]) => {
        log
          .debug()
          .str('class', 'ProcessorRegistry')
          .str('function', 'processRecordsByService')
          .str('service', serviceType)
          .num('recordCount', records.length)
          .msg('Processing records for service type');

        try {
          // Find the matching processor for this service type
          const processor = this.findProcessorForService(serviceType);

          // Process the records using the appropriate processor
          const {batchItemFailures, batchItemBodies} =
            await processor.process(records);

          // Clear cache entries for successfully processed records
          const failedMessageIds = new Set(
            batchItemFailures.map((f) => f.itemIdentifier),
          );
          records.forEach((record) => {
            // Only clear cache for successfully processed records (not in failures)
            if (!failedMessageIds.has(record.messageId)) {
              this.clearCacheEntry(record.messageId);
            }
          });

          if (batchItemFailures.length > 0) {
            return {
              service: serviceType,
              failures: {batchItemFailures, batchItemBodies},
            };
          }

          return {service: serviceType, failures: null};
        } catch (error) {
          log
            .error()
            .str('class', 'ProcessorRegistry')
            .str('function', 'processRecordsByService')
            .str('service', serviceType)
            .err(error)
            .msg('Error processing service records');

          // Clear cache entries for all records in this service when processing fails
          records.forEach((record) => {
            this.clearCacheEntry(record.messageId);
          });

          return {
            service: serviceType,
            failures: {
              batchItemFailures: records.map((r) => ({
                itemIdentifier: r.messageId,
              })),
              batchItemBodies: records,
            },
          };
        }
      }),
    );

    // Collect all failures
    results
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<{
          service: ServiceType;
          failures: SQSFailureResponse | null;
        }> => result.status === 'fulfilled' && result.value.failures !== null,
      )
      .forEach((result) => {
        if (result.value.failures) {
          batchItemFailures.push(...result.value.failures.batchItemFailures);
          batchItemBodies.push(...result.value.failures.batchItemBodies);
        }
      });

    // Also collect failures from rejected promises
    results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      .forEach((result) => {
        log
          .error()
          .str('class', 'ProcessorRegistry')
          .str('function', 'processRecordsByService')
          .err(result.reason)
          .msg('Service processing failed with unhandled error');
        batchItemFailures.push(...result.reason.failures.batchItemFailures);
        batchItemBodies.push(...result.reason.failures.batchItemBodies);
      });

    return {batchItemFailures, batchItemBodies};
  }

  /**
   * Find a processor for the given service type
   * Type-safe lookup mechanism for processor instances
   * @param serviceType Service type to find processor for
   * @returns Matching processor
   * @throws Error if no processor found for the given service type
   */
  // TODO: Please keep alphabetical order when adding new processors and service types
  private findProcessorForService(serviceType: ServiceType): ServiceProcessor {
    let processor: ServiceProcessor | undefined;

    switch (serviceType) {
      case 'alb':
        processor = this.processors.find((p) => p instanceof ALBProcessor);
        break;
      case 'cloudfront':
        processor = this.processors.find(
          (p) => p instanceof CloudFrontProcessor,
        );
        break;
      case 'ec2':
        processor = this.processors.find((p) => p instanceof EC2Processor);
        break;
      case 'opensearch':
        processor = this.processors.find(
          (p) => p instanceof OpenSearchProcessor,
        );
        break;
      case 'rds':
        processor = this.processors.find((p) => p instanceof RDSProcessor);
        break;
      case 'rds-cluster':
        processor = this.processors.find(
          (p) => p instanceof RDSClusterProcessor,
        );
        break;
      case 'route53-resolver':
        processor = this.processors.find(
          (p) => p instanceof Route53ResolverProcessor,
        );
        break;
      case 'sqs':
        processor = this.processors.find((p) => p instanceof SQSProcessor);
        break;
      case 'step-function':
        processor = this.processors.find(
          (p) => p instanceof StepFunctionProcessor,
        );
        break;
      case 'targetgroup':
        processor = this.processors.find(
          (p) => p instanceof TargetGroupProcessor,
        );
        break;
      case 'transit-gateway':
        processor = this.processors.find(
          (p) => p instanceof TransitGatewayProcessor,
        );
        break;
      case 'vpn':
        processor = this.processors.find((p) => p instanceof VPNProcessor);
        break;
      default:
        log
          .fatal()
          .str('class', 'ProcessorRegistry')
          .str('function', 'findProcessorForService')
          .str('serviceType', serviceType)
          .msg('No processor type defined for service type');
        throw new Error(`No processor found for service type: ${serviceType}`);
    }

    if (!processor) {
      log
        .fatal()
        .str('class', 'ProcessorRegistry')
        .str('function', 'findProcessorForService')
        .str('serviceType', serviceType)
        .msg('Processor not initialized for service type');
      throw new Error(
        `Processor for service type ${serviceType} was not properly initialized`,
      );
    }

    return processor;
  }
}
