import {SQSBatchItemFailure, SQSRecord} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {
  ServiceProcessorMap,
  ServiceType, ServiceTypePattern,
  SQSFailureResponse,
} from './types.mjs';
import {
  ALBProcessor,
  CloudFrontProcessor,
  EC2Processor,
  OpenSearchProcessor,
  RDSClusterProcessor,
  RDSProcessor,
  Route53ResolverProcessor,
  SQSProcessor,
} from './processors-temp.mjs';
import {EventPatterns} from './enums.mjs';

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

class ServiceStringType {
}

/**
 * Registry that manages all service processors and handles routing
 */
export class ProcessorFactory {
  private processors: Map<ServiceType, ServiceProcessorMap>;
  protected serviceProcessorsMap: Map<ServiceType, ServiceProcessorMap>;

  /**
   * Cache for storing stringified records to avoid repeated JSON processing
   * Keys are message IDs, values are the stringified record bodies
   * Cache entries are cleared after successful processing or on reset
   */
  private stringifiedCache = new Map<string, string>();

  /**
   * Create a new processor registry
   * This constructor initializes a mapped registry of all the specialized processors for each AWS service type.
   */
  constructor() {
    // Initialize specialized processors
    this.processors = this.ProcessorMap();

    log
      .info()
      .str('class', 'ProcessorFactory')
      .str('function', 'constructor')
      .num('processorCount', this.processors.length)
      .msg('ProcessorFactory initialized with specialized processors');
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
   * Initialize all service processor mappings
   * Contains service type, service event pattern, and the actual processor class
   */
  private ProcessorMap = () => {
    return new Map<ServiceType, ServiceProcessorMap>([
      [
        'alb',
        {
          serviceEventPattern: EventPatterns.alb,
          serviceProcessor: {
            create: (records: SQSRecord[]) => new ALBProcessor(records)
          }
        },
      ],
      [
        'cloudfront',
        {
          serviceEventPattern: EventPatterns.cloudfront,
          serviceProcessor: {
            create: (records: SQSRecord[]) => new CloudFrontProcessor(records)
          }
        },
      ],
      [
        'ec2',
        {
          serviceEventPattern: EventPatterns.ec2,
          serviceProcessor: {
            create: (records: SQSRecord[]) => new EC2Processor(records)
          }
        },
      ],
      [
        'opensearch',
        {
          serviceEventPattern: EventPatterns.opensearch,
          serviceProcessor: {
            create: (records: SQSRecord[]) => new OpenSearchProcessor(records)
          }
        },
      ],
      [
        'rds',
        {
          serviceEventPattern: EventPatterns.rds,
          serviceProcessor: {
            create: (records: SQSRecord[]) => new RDSProcessor(records)
          }
        },
      ],
      [
        'rdscluster',
        {
          serviceEventPattern: EventPatterns.rdscluster,
          serviceProcessor: {
            create: (records: SQSRecord[]) => new RDSClusterProcessor(records)
          }
        },
      ],
      [
        'route53resolver',
        {
          serviceEventPattern: EventPatterns.route53resolver,
          serviceProcessor: {
            create: (records: SQSRecord[]) => new Route53ResolverProcessor(records)
          }
        },
      ],
      [
        'sqs',
        {
          serviceEventPattern: EventPatterns.sqs,
          serviceProcessor: {
            create: (records: SQSRecord[]) => new SQSProcessor(records)
          }
        },
      ],
      [
        'sfn',
        {
          serviceEventPattern: EventPatterns.sfn,
          serviceProcessor: {
            create: (records: SQSRecord[]) => new CloudFrontProcessor(records)
          }
        },
      ], // Placeholder for now
      [
        'targetgroup',
        {
          serviceEventPattern: EventPatterns.targetgroup,
          serviceProcessor: {
            create: (records: SQSRecord[]) => new ALBProcessor(records)
          }
        },
      ],
      [
        'transitgateway',
        {
          serviceEventPattern: EventPatterns.transitgateway,
          serviceProcessor: {
            create: (records: SQSRecord[]) => new EC2Processor(records)
          }
        },
      ],
      [
        'vpn',
        {
          serviceEventPattern: EventPatterns.vpn,
          serviceProcessor: {
            create: (records: SQSRecord[]) => new EC2Processor(records)
          }
        },
      ],
    ]);

    log
      .debug()
      .str('class', 'ProcessorFactory')
      .str('function', 'initializeProcessorMap')
      .num('processorCount', this.processors.length)
      .msg('Initialized all service processor mappings');
  };

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
    const serviceMap = new Map<ServiceType['key'], SQSRecord[]>();
    const uncategorizedRecords: SQSRecord[] = [];

    // Loop through records and categorize by service type
    for (const record of records) {
      // Coerce the messageGroupId into a string for comparison against service types
      const messageGroupId: string = record.messageAttributes
        .messageGroupId as unknown as string;

      /**
       * Check if the record has a messageGroupId against all service types across service types in EventPatterns enum.
       * Promise.any creates a race between EventPatterns Enum keys who's service type is contained in the messageGroupId.
       * Each EventPattern key returns a promise that resolves if its service type is contained in the messageGroupId
       * When any EventPattern key resolves: Promise.any.then() categorizes the record by the matching service type
       * If all processors fail: Promise.any.catch() adds the record to uncategorized records to an array for handling in main-handler.mts
       */
      await Promise.any(
        Object.keys(EventPatterns).map((K) => {
          return new Promise<ServiceType>((resolve, reject) => {
            if (messageGroupId.toLowerCase().includes(K)) {
              resolve(K as ServiceType); // Resolve with the matching service type pattern
            } else {
              reject();
            }
          });
        }), // End of new Promise for each EventPatterns key
      )
        //TODO: once we get the service process mapping in place we can use the actual processor class to resolve the service type instead of just the string match in messageGroupId
        // and instead of initializing all processors, we can only initialize the ones that match the messageGroupId in the first place.
        // Resolve the service type in Promise.any from the first resolving processor Promise and categorize the record
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
        // Handle the case where no processor was able to categorize the record in any processor Promise
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

          //add to uncategorized records if no processor was able to find a match
          uncategorizedRecords.push(record);
        }); // End of Promise.any for processors
    } // End of for loop over records

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
          .str('class', 'ProcessorFactory')
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
            .str('class', 'ProcessorFactory')
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
