import {SQSBatchItemFailure, SQSRecord} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {ServiceProps, ServiceType, SQSFailureResponse} from './types.mjs';
import {
  ALBProcessor,
  CloudFrontProcessor,
  EC2Processor,
  OpenSearchProcessor,
  RDSClusterProcessor,
  RDSProcessor,
  Route53ResolverProcessor,
  SQSProcessor,
  StepFunctionProcessor, TargetGroupProcessor, TransitGatewayProcessor, VPNProcessor,
} from './processors-temp.mjs';


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
  //TODO: We can make this even better buy just looking at the queue it came from - MessageGroupID
  // This way we can avoid the searchRecord function in processors that can't process an unrelated record
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

// TODO: Add config parsing, alarm creation, tag fetching, and other common functionality to this abstract class
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
  //TODO: Ensure any class extended from this one includes handling for records without an ARN when implementing this function
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




