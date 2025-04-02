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
  StepFunctionProcessor,
  TargetGroupProcessor,
  TransitGatewayProcessor,
  VPNProcessor,
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
  record: SQSRecord | string | Record<string, unknown>,
  searchPattern: string,
  endDelimiter: string,
): string | undefined {
  // Used to store striginified record data across record types
  let recordString: string;

  // Anonymous function to search for the pattern in the record and return the result
  const getSearchResult = (): string | undefined => {
    let startIndex: number;
    let endIndex: number;

    // Try to get start and end index of the pattern
    try {
      startIndex = recordString.indexOf(searchPattern);
      endIndex = recordString.indexOf(endDelimiter, startIndex);
      return recordString.substring(startIndex, endIndex);
    } catch (e) {
      log
        .error()
        .str('function', 'eventSearch')
        .str('searchPattern', searchPattern)
        .err(e)
        .msg('Error searching for pattern in record');
      return undefined;
    }
  };

  /**
   * Record handling logic based on the type of record passed with early conditional returns
   * Handle string records directly
   * Fall back logic if the record is not a string but is an SQS record
   * Fallback for other record types for future compatability with other object parsing if needed
   */
  if (typeof record === 'string') {
    recordString = record;
    return getSearchResult();
  }

  if (typeof record === 'object' && record.body) {
    recordString = JSON.stringify(record.body);
    return getSearchResult();
  }

  if (typeof record === 'object' && record) {
    recordString = JSON.stringify(record);
    return getSearchResult();
  }

  // Log an error and return undefined if no supported record type is found
  log
    .error()
    .str('function', 'eventSearch')
    .str('searchPattern', searchPattern)
    .str('recordType', typeof record)
    .unknown('record', record)
    .msg('Unsupported record type for event search');
  return undefined;
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
  async categorizeRecords(records: SQSRecord[]): Promise<{
    serviceMap: Map<ServiceType, SQSRecord[]>;
    uncategorizedRecords: SQSRecord[];
  }> {
    const serviceMap = new Map<ServiceType, SQSRecord[]>();
    const uncategorizedRecords: SQSRecord[] = [];

    // Loop through records and categorize by service type
    for (const record of records) {
      // Coerce the messageGroupId into a string for comparison against service types
      const messageGroupId: string = record.messageAttributes
        .messageGroupId as unknown as string;

      // Asynchronously search for the service type in the messageGroupId, set the service type, and categorize the record
      await Promise.any([
        new Promise<ServiceType>((resolve, reject) => {
          this.processors.forEach((p) => {
            const serviceType = p.getServiceType();
            if (messageGroupId.includes(serviceType)) {
              resolve(serviceType);
            } else {
              reject('No service type found in SQS record messageGroupId');
            }
          });
        }),
      ])
        .then((serviceType) => {
          log
            .debug()
            .str('class', 'ProcessorRegistry')
            .str('function', 'categorizeRecords')
            .str('messageId', record.messageId)
            .str('serviceType', serviceType)
            .msg('Successfully resolved service type from messageGroupId');

          // Initialize array for this service if needed
          if (!serviceMap.has(serviceType)) {
            serviceMap.set(serviceType, []);
          }

          // Add record to the appropriate service category
          serviceMap.get(serviceType)!.push(record);
        })
        .catch((error) => {
          log
            .error()
            .str('class', 'ProcessorRegistry')
            .str('function', 'categorizeRecords')
            .str('messageId', record.messageId)
            .str('Failed Promises: ', error.join('\n'))
            .msg(
              'Unable to categorize record sending back to Queue for reprocessing',
            );

          //add to uncategorized records if no processor was able to find a match
          uncategorizedRecords.push(record);
        });
    }

    // Log categorization results
    log
      .debug()
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
      case 'rdscluster':
        processor = this.processors.find(
          (p) => p instanceof RDSClusterProcessor,
        );
        break;
      case 'route53resolver':
        processor = this.processors.find(
          (p) => p instanceof Route53ResolverProcessor,
        );
        break;
      case 'sqs':
        processor = this.processors.find((p) => p instanceof SQSProcessor);
        break;
      case 'sfn':
        processor = this.processors.find(
          (p) => p instanceof StepFunctionProcessor,
        );
        break;
      case 'targetgroup':
        processor = this.processors.find(
          (p) => p instanceof TargetGroupProcessor,
        );
        break;
      case 'transitgateway':
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
  //Todo: Will likely need to add tags and other info needed from describe api calls
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

    if (eventSearch(stringified, pattern, endDelimiter)) {
      return eventSearch(stringified, pattern, endDelimiter)!;
    } else {
      log
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
