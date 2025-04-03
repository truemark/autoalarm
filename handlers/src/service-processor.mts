/**
 * Abstract base class for all service-specific alarm processors
 *
 * Defines the contract and shared functionality that all service-specific
 * processors must implement. This class is the cornerstone of the processor-based
 * architecture, providing standardized interfaces for record processing while
 * enabling service-specific implementations.
 *
 * @abstract
 * @class
 *
 * @description
 * The ServiceProcessor architecture enables:
 * 1. Service-specific optimizations (e.g., EC2 batch processing)
 * 2. Clear separation of responsibilities per AWS service
 * 3. Consistent error handling and failure reporting across services
 * 4. Straightforward extensibility through new processor implementations
 * 5. Standardized logging and event searching capabilities
 *
 * Each service processor is responsible for:
 * - Determining if it can process a specific SQS record
 * - Processing batches of records for its service type
 * - Reporting failures in a consistent format
 * - Implementing service-specific alarm creation logic
 *
 * @example
 * ```typescript
 * export class EC2Processor extends ServiceProcessor {
 *   private records: SQSRecord[];
 *
 *   constructor(records: SQSRecord[]) {
 *     super('ec2');
 *     this.records = records;
 *   }
 *
 *   canProcess(record: SQSRecord): boolean {
 *     // Implementation specific to EC2
 *   }
 *
 *   async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
 *     // EC2-specific implementation
 *   }
 * }
 * ```
 *
 * @remarks
 * In AWS Lambda environments, processors are instantiated on demand and
 * maintained for the duration of a single invocation. The factory/registry pattern
 * optimizes processor creation while maintaining clean state boundaries between
 * invocations.
 */
import {ServiceType, SQSFailureResponse} from './types.mjs';
import {SQSRecord} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {eventSearch} from './processor-factory.mjs';

// TODO: Add config parsing, alarm creation, tag fetching, and other common functionality to this abstract class
export abstract class ServiceProcessor {
  protected readonly log: logging.Logger;

  /**
   * Creates a new ServiceProcessor instance
   *
   * Initializes the base functionality for a service processor, including
   * setting up service-specific logging. Each concrete processor must call
   * this constructor with its corresponding service type.
   *
   * @param serviceType - The AWS service type identifier for this processor
   *
   * @example
   * ```typescript
   * constructor(records: SQSRecord[]) {
   *   super('ec2'); // Initialize the base processor with service type
   *   this.records = records; // Store service-specific state
   * }
   * ```
   *
   * @remarks
   * Future enhancements may include passing additional parameters such as:
   * - AWS SDK clients
   * - Configuration settings
   * - Resource tagging information for alarm creation
   */
  constructor(protected readonly serviceType: ServiceType) {
    this.log = logging.getLogger(`${serviceType}-Processor`);
  }

  /**
   * Determines whether this processor can handle the given SQS record
   *
   * This method examines the record to determine if it belongs to the service type
   * that this processor is responsible for. Each service processor must implement
   * specific logic to identify its records, typically by examining ARNs, message
   * attributes, or content patterns.
   *
   * @param record - The SQS record to evaluate
   * @returns `true` if this processor should handle the record, `false` otherwise
   *
   * @remarks
   * Implementations should:
   * - Handle cases where records might not contain an ARN
   * - Be efficient as this method may be called frequently during record categorization
   * - Avoid throwing exceptions; return false for unrecognized records
   * - Consider service-specific edge cases (e.g., EC2 records that are actually VPN)
   */
  abstract canProcess(record: SQSRecord): boolean;

  /**
   * Processes a batch of records for this service type
   *
   * This method contains the core processing logic for a specific AWS service.
   * It's responsible for transforming records, making AWS API calls, creating
   * CloudWatch alarms, and tracking any failures.
   *
   * @param records - Array of SQS records to process, all belonging to this service type
   * @returns Promise resolving to an SQSFailureResponse containing any failed records
   *
   * @remarks
   * Implementations should:
   * - Optimize for batch processing where possible (e.g., consolidating AWS API calls)
   * - Handle partial batch failures gracefully
   * - Provide detailed error logging
   * - Return any failed records for Lambda's batch item failure mechanism
   * - Be idempotent where possible to handle potential reprocessing
   *
   * @example
   * ```typescript
   * async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
   *   const batchItemFailures: SQSBatchItemFailure[] = [];
   *   const batchItemBodies: SQSRecord[] = [];
   *
   *   // Process records...
   *
   *   return { batchItemFailures, batchItemBodies };
   * }
   * ```
   */
  abstract process(records: SQSRecord[]): Promise<SQSFailureResponse>;

  /**
   * Helper method to get a stringified version of a record for pattern matching
   *
   * Converts an SQS record's body to a JSON string representation for use in
   * pattern matching operations. This consistent string format is essential for
   * reliable ARN and resource identifier extraction.
   *
   * @param record - The SQS record to stringify
   * @returns A string representation of the record body
   *
   * @remarks
   * Uses the same stringification approach as the eventSearch utility function
   * to ensure consistent pattern matching across the application.
   *
   * @protected
   */
  protected getStringifiedRecord(record: SQSRecord): string {
    // For consistency with eventSearch, we use JSON.stringify(record.body)
    return JSON.stringify(record.body);
  }

  /**
   * Helper method to search for patterns in records
   *
   * Searches for a specific pattern within an SQS record and extracts the matching
   * substring. This is primarily used to extract ARNs and resource identifiers from
   * event payloads to determine record ownership and extract resource information.
   *
   * @param record - The SQS record to search within
   * @param pattern - The pattern string to search for (typically an ARN prefix)
   * @param endDelimiter - Character that marks the end of the pattern (defaults to '"')
   * @returns The matched string containing the pattern and content up to the delimiter
   * @throws Error if the pattern is not found in the record
   *
   * @protected
   */
  protected searchRecord(
    record: SQSRecord,
    pattern: string,
    endDelimiter: string = '"',
  ): string {
    const stringified = this.getStringifiedRecord(record);

    if (eventSearch(stringified, pattern, endDelimiter)) {
      return eventSearch(stringified, pattern, endDelimiter)!;
    } else {
      this.log
        .error()
        .str('function', 'searchRecord')
        .str('pattern', pattern)
        .str('record', stringified)
        .msg('Error searching for pattern in record');
      throw new Error(
        "Error searching for pattern in record. Event Search didn't return a value",
      );
    }
  }
}
