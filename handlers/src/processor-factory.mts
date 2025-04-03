import {SQSBatchItemFailure, SQSRecord} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {ServiceType, SQSFailureResponse} from './types.mjs';
import {ServiceProcessor} from './service-processor.mjs';
import {ProcessorRegistry} from './processor-registry.mjs';
import {EventPatterns} from './enums.mjs';

const log: logging.Logger = logging.getLogger('service-router');

/**
 * Helper function to search for resource identifiers in events
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

  // Handle different types of input for the record parameter
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
 * Service Processor Factory that creates and manages routing and processing
 */
export class ProcessorFactory {
  // Cache of instantiated processor instances (created on demand)
  private processorInstances: Map<ServiceType, ServiceProcessor> = new Map();

  /**
   * Cache for storing stringified records to avoid repeated JSON processing
   * Keys are message IDs, values are the stringified record bodies
   */
  private stringifiedCache = new Map<string, string>();
  constructor() {
    // Initialize ProcessorRegistry if not already done
    if (ProcessorRegistry.getServiceTypes().length === 0) {
      ProcessorRegistry.initialize();
    }

    log
      .info()
      .str('class', 'ProcessorFactory')
      .str('function', 'constructor')
      .num('registeredProcessors', ProcessorRegistry.getServiceTypes().length)
      .msg('ProcessorFactory initialized with processor registry');
  }

  /**
   * Reset any past-invocation state
   * This prevents cross-invocation data leakage and memory buildup
   */
  reset(): void {
    // Clear caches to prevent memory leaks between invocations
    this.stringifiedCache.clear();
    this.processorInstances.clear();

    log
      .trace()
      .str('class', 'ProcessorFactory')
      .str('function', 'reset')
      .msg('ProcessorFactory state reset for new invocation');
  }

  /**
   * Remove a record from the cache once it's been processed
   * This helps manage memory usage during processing
   * @param messageId The SQS message ID to remove from cache
   */
  private clearCacheEntry(messageId: string): void {
    if (this.stringifiedCache.has(messageId)) {
      this.stringifiedCache.delete(messageId);
    }
  }

  /**
   * Gets or creates a processor instance for the given service type
   * @param serviceType The service type to get a processor for
   * @param records[] The SQS records to process
   * @returns The processor instance
   */
  private getProcessor(
    serviceType: ServiceType,
    records: SQSRecord[],
  ): ServiceProcessor {
    if (!this.processorInstances.has(serviceType)) {
      const processor = ProcessorRegistry.createProcessor(serviceType, records);
      if (!processor) {
        throw new Error(
          `No processor registered for service type: ${serviceType}`,
        );
      }
      this.processorInstances.set(serviceType, processor);
    }

    return this.processorInstances.get(serviceType)!;
  }

  /**
   * Categorize records by service type
   * Maps each SQS record to its corresponding service processor
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

      /**
       * Check the record messageGroupId against all service types defined in the EventPatterns Enum.
       * Promise.any creates a race between service types, resolving with the correct processor. No need to wait.
       */
      await Promise.any(
        Object.keys(EventPatterns).map((K) => {
          return new Promise<ServiceType>((resolve, reject) => {
            if (messageGroupId.toLowerCase().includes(K)) {
              resolve(K as keyof typeof EventPatterns);
            } else {
              reject();
            }
          }); // End of Enum key matching Promise
        }),
      )
        .then((serviceType) => {
          log
            .debug()
            .str('class', 'ProcessorFactory')
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
        .catch((error: Error) => {
          log
            .error()
            .str('class', 'ProcessorFactory')
            .str('function', 'categorizeRecords')
            .str('messageId', record.messageId)
            .str(
              'Failed Promises: ',
              error instanceof AggregateError
                ? error.errors.join('\n')
                : String(error),
            )
            .msg(
              'Unable to categorize record sending back to Queue for reprocessing',
            );

          // Add to uncategorized records if no processor was able to find a match
          uncategorizedRecords.push(record);
        }); // End of Promise.any for service type Categorization
    } // End of records loop

    // Log categorization results
    log
      .debug()
      .str('class', 'ProcessorFactory')
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
        .str('class', 'ProcessorFactory')
        .str('function', 'categorizeRecords')
        .str('serviceBreakdown', serviceBreakdown)
        .msg('Service categorization breakdown');
    }

    return {serviceMap, uncategorizedRecords};
  }

  /**
   * Process records by service type concurrently
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
        try {
          // Get or create the processor for this service type
          const processor = this.getProcessor(serviceType, records);

          // Process the records using the appropriate processor
          const {batchItemFailures, batchItemBodies} =
            await processor.process(records);

          // Create a set of failed message IDs from the batchItemFailures that we'll use to clear the cache
          const failedMessageIds = new Set(
            batchItemFailures.map((f) => f.itemIdentifier),
          );

          // Look through failedMessageIds and clear the cache for only those records that were successfully processed
          records.forEach((record) => {
            if (!failedMessageIds.has(record.messageId)) {
              this.clearCacheEntry(record.messageId);
            }
          });

          // Return the failures to aggregate to send to main handler
          if (batchItemFailures.length > 0) {
            return {
              service: serviceType,
              failures: {batchItemFailures, batchItemBodies},
            };
          }

          // If no failures, return null to indicate success for this service
          return {service: serviceType, failures: null};
        } catch (error) {
          log
            .error()
            .str('class', 'ProcessorFactory')
            .str('function', 'processRecordsByService')
            .str('service', serviceType)
            .err(error)
            .msg('Error processing service records');

          // Clear cache entries for all records in this service when processing fails
          records.forEach((record) => {
            this.clearCacheEntry(record.messageId);
          });

          // In case of an unhandled error, return the failure response for the service with all records
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
    ); // End of results Promise.allSettled

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
          .str('class', 'ProcessorFactory')
          .str('function', 'processRecordsByService')
          .err(result.reason)
          .msg('Service processing failed with unhandled error');
        batchItemFailures.push(...result.reason.failures.batchItemFailures);
        batchItemBodies.push(...result.reason.failures.batchItemBodies);
      });

    return {batchItemFailures, batchItemBodies};
  }
}
