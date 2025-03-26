import {SQSBatchItemFailure, SQSRecord} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {
  AsyncAlarmManager,
  ServiceProps,
  ServiceType,
  SQSFailureResponse,
} from './types.mjs';
import {manageEC2} from './ec2-modules.mjs';

const log: logging.Logger = logging.getLogger('service-router');

/**
 * Helper function to search for resource identifiers in events
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
    recordString = record;
  } else {
    recordString = record.body
      ? JSON.stringify(record.body)
      : JSON.stringify(record);
  }

  const startIndex = recordString.indexOf(searchPattern);
  if (startIndex === -1) {
    log
      .error()
      .str('function', 'eventSearch')
      .str('searchPattern', searchPattern)
      .msg('Event search failed for search pattern');
    return '';
  }

  const endIndex = recordString.indexOf(endDelimiter, startIndex);
  if (endIndex === -1) {
    log
      .error()
      .str('function', 'eventSearch')
      .str('endDelimiter', endDelimiter)
      .msg('Event search failed for end delimiter');
    return '';
  }

  return recordString.substring(startIndex, endIndex);
}

/**
 * ServiceRouter class for routing SQS records to appropriate handlers
 * based on service identifiers found in the event data
 */
export class ServiceRouter {
  private serviceProps: ServiceProps[];
  private serviceHandlers: Map<ServiceType, AsyncAlarmManager>;

  /**
   * Create a new ServiceRouter
   * @param serviceProps Array of service mappings
   */
  constructor(serviceProps: ServiceProps[]) {
    this.serviceProps = serviceProps;
    
    // Build a map of service types to handlers for direct lookups
    this.serviceHandlers = new Map();
    serviceProps.forEach(prop => {
      this.serviceHandlers.set(prop.service, prop.handler);
    });
    
    log
      .info()
      .num('serviceConfigsCount', serviceProps.length)
      .msg('ServiceRouter initialized');
  }
  
  /**
   * Get the handler for a specific service type
   * @param serviceType The service type to get the handler for
   * @returns The handler function for the specified service
   */
  getHandlerForService(serviceType: ServiceType): AsyncAlarmManager {
    const handler = this.serviceHandlers.get(serviceType);
    if (!handler) {
      throw new Error(`No handler found for service type: ${serviceType}`);
    }
    return handler;
  }

  /**
   * Find the appropriate handler for the given record
   * @param record SQS record to process
   * @returns Object containing the service type and handler, or undefined if no match
   */
  private findHandler(record: SQSRecord, stringRecord: string): 
    {
        service: ServiceType;
        handler: AsyncAlarmManager;
    } | undefined {
    for (const mapping of this.serviceProps) {
      // Try each identifier for this service
      for (const identifier of mapping.identifiers) {
        try {
          const result = eventSearch(stringRecord, identifier, '"');
          if (result) {
            log
              .debug()
              .str('service', mapping.service)
              .str('identifier', identifier)
              .str('messageId', record.messageId)
              .msg('Found matching service for record');
            return {
              service: mapping.service,
              handler: mapping.handler,
            };
          }
        } catch (error) {
          log
            .error()
            .str('class', 'ServiceRouter')
            .str('function', 'findHandler')
            .str('service', mapping.service)
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error searching for service identifier');
        }

      }
    }

    log
      .error()
      .str('messageId', record.messageId)
      .msg('No matching service handler found for record');
    return undefined;
  }

  /**
   * Process EC2 records in a batch using workflow to extract instance IDs
   * @param records Array of SQS records to process
   * @returns SQS failure response if there were any failures
   */
  async processEC2Batch(
    records: SQSRecord[],
  ): Promise<{
    failureResponse?: SQSFailureResponse;
  }> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];
    const ec2InstanceMap: Record<string, SQSRecord>[] = [];
    
    // Transform records into the format expected by manageEC2
    for (const record of records) {
      try {
        const stringyJson = JSON.parse(record.body);
        const searchResult: string = eventSearch(
          stringyJson,
          'arn:aws:ec2:',
          '"',
        );

        if (searchResult) {
          // Extract instance ID
          const instanceId = searchResult.split('/').pop();
          
          if (instanceId) {
            log
              .trace()
              .str('function', 'processEC2Batch')
              .str('messageId', record.messageId)
              .str('instanceId', instanceId)
              .msg('Processing EC2 instance ID');
              
            ec2InstanceMap.push({[searchResult]: record});
          }
        }
      } catch (error) {
        log
          .error()
          .str('function', 'processEC2Batch')
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
      log
        .info()
        .num('instanceIDs', ec2InstanceMap.length)
        .msg('Processing batch of EC2 instances');
        
      try {
        const ec2FailedRecords = await manageEC2(ec2InstanceMap);

        if (ec2FailedRecords.length > 0) {
          log
            .error()
            .str('function', 'processEC2Batch')
            .num('failedItems', ec2FailedRecords.length)
            .msg('Batch item failures found in EC2 processing');
            
          ec2FailedRecords.forEach(record => {
            const messageId = record[Object.keys(record)[0]].messageId;
            batchItemFailures.push({
              itemIdentifier: messageId,
            });
            batchItemBodies.push(record[Object.keys(record)[0]]);
          });
        }
      } catch (error) {
        log
          .error()
          .str('function', 'processEC2Batch')
          .err(error)
          .msg('Unhandled error during batch EC2 processing');
          
        // Add all records from the batch to failures since we can't determine which ones failed
        ec2InstanceMap.forEach(record => {
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
      failureResponse: batchItemFailures.length > 0 
        ? { batchItemFailures, batchItemBodies } 
        : undefined
    };
  }
  
  /**
   * Process EC2 records in a batch using workflow to extract instance IDs
   * @param records Array of SQS records to process
   * @returns Object containing processed EC2 records IDs and any failed batch items
   * @deprecated Use categorizeEvents and processEC2Batch instead
   */
  async processEC2(
    records: SQSRecord[],
  ): Promise<{
    processedRecordIds: Set<string>;
    failureResponse?: SQSFailureResponse;
  }> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];
    const ec2InstanceMap: Record<string, SQSRecord>[] = [];
    const processedRecordIds = new Set<string>();
    
    // First pass: identify all EC2 events and filter out VPN/Transit Gateway
    const ec2Records = await Promise.all(
      records.map(async (record) => {
        try {
          const stringyJson = JSON.parse(record.body);
          const searchResult: string = eventSearch(
            stringyJson,
            'arn:aws:ec2:',
            '"',
          );

          if (searchResult) {
            // Skip VPN and Transit Gateway events early
            if (searchResult.includes('vpn') || searchResult.includes('transit')) {
              log
                .trace()
                .str('service', 'ServiceRouter')
                .str('function', 'processEC2')
                .str('messageId', record.messageId)
                .msg('Skipping VPN and Transit Gateway event');
              
              // Still mark as processed to avoid double processing
              processedRecordIds.add(record.messageId);
              return null;
            }

            processedRecordIds.add(record.messageId);
            const instanceId = searchResult.split('/').pop();
            
            if (instanceId) {
              log
                .trace()
                .str('service', 'ServiceRouter')
                .str('function', 'processEC2')
                .str('messageId', record.messageId)
                .str('instanceId', instanceId)
                .msg('Found EC2 instance ID in event');
                
              return { 
                instanceId: searchResult, 
                record 
              };
            }
          }
          return null;
        } catch (error) {
          log
            .error()
            .str('service', 'ServiceRouter')
            .str('function', 'processEC2')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error parsing EC2 event');
            
          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          
          // Mark as processed even if it failed, to avoid double processing
          processedRecordIds.add(record.messageId);
          return null;
        }
      })
    );
    
    // Filter out nulls and map to the format expected by manageEC2
    const validRecords = ec2Records.filter(Boolean);
    
    // Transform records for EC2 processing
    validRecords.forEach(record => {
      if (record) {
        ec2InstanceMap.push({[record.instanceId]: record.record});
      }
    });

    // If we found EC2 instances, process them in batch
    if (ec2InstanceMap.length > 0) {
      log
        .info()
        .num('instanceIDs', ec2InstanceMap.length)
        .msg('Processing batch of EC2 instances');
        
      try {
        const ec2FailedRecords = await manageEC2(ec2InstanceMap);

        if (ec2FailedRecords.length > 0) {
          log
            .error()
            .str('function', 'processEC2')
            .num('failedItems', ec2FailedRecords.length)
            .msg('Batch item failures found in EC2 processing');
            
          ec2FailedRecords.forEach(record => {
            const messageId = record[Object.keys(record)[0]].messageId;
            batchItemFailures.push({
              itemIdentifier: messageId,
            });
            batchItemBodies.push(record[Object.keys(record)[0]]);
          });
        }
      } catch (error) {
        log
          .error()
          .str('function', 'processEC2')
          .err(error)
          .msg('Unhandled error during batch EC2 processing');
          
        // Add all records from the batch to failures since we can't determine which ones failed
        ec2InstanceMap.forEach(record => {
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
      processedRecordIds,
      failureResponse: batchItemFailures.length > 0 
        ? { batchItemFailures, batchItemBodies } 
        : undefined
    };
  }

  /**
   * Categorize all SQS records by service type
   * @param records Array of SQS records to categorize
   * @returns Map of service types to arrays of records
   */
  async categorizeEvents(records: SQSRecord[]): Promise<{
    serviceMap: Map<ServiceType, SQSRecord[]>;
    uncategorizedRecords: SQSRecord[];
  }> {
    const serviceMap = new Map<ServiceType, SQSRecord[]>();
    const uncategorizedRecords: SQSRecord[] = [];
    
    // Process all records in parallel
    const results = await Promise.allSettled(
      records.map(async (record) => {
        try {
          // Parse the record body once
          const stringRecord = JSON.parse(record.body);
          const handlerInfo = this.findHandler(record, stringRecord);
          
          if (handlerInfo) {
            // Skip EC2 VPN and transit gateway events early
            if (handlerInfo.service === 'ec2') {
              const searchResult = eventSearch(stringRecord, 'arn:aws:ec2:', '"');
              if (searchResult && (searchResult.includes('vpn') || searchResult.includes('transit'))) {
                log
                  .trace()
                  .str('service', 'ServiceRouter')
                  .str('function', 'categorizeEvents')
                  .str('messageId', record.messageId)
                  .msg('Skipping VPN and Transit Gateway event');
                return null;
              }
            }

            return {
              service: handlerInfo.service,
              record,
              stringRecord
            };
          }
          
          log
            .warn()
            .str('messageId', record.messageId)
            .msg('Unable to categorize record - no matching service found');
          uncategorizedRecords.push(record);
          return null;
        } catch (error) {
          log
            .error()
            .str('function', 'categorizeEvents')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error categorizing record');
          uncategorizedRecords.push(record);
          return null;
        }
      })
    );
    
    // Process successful categorizations
    results
      .filter((result): result is PromiseFulfilledResult<{service: ServiceType; record: SQSRecord; stringRecord: any} | null> => 
        result.status === 'fulfilled' && result.value !== null)
      .forEach(result => {
        if (result.value) {
          const { service, record } = result.value;
          
          // Initialize array for this service if needed
          if (!serviceMap.has(service)) {
            serviceMap.set(service, []);
          }
          
          // Add record to the appropriate service category
          serviceMap.get(service)!.push(record);
        }
      });
      
    // Log categorization results
    log
      .info()
      .num('totalRecords', records.length)
      .num('categorizedServices', serviceMap.size)
      .num('uncategorizedRecords', uncategorizedRecords.length)
      .msg('Record categorization complete');
      
    Array.from(serviceMap.entries()).forEach(([service, serviceRecords]) => {
      log
        .info()
        .str('service', service)
        .num('recordCount', serviceRecords.length)
        .msg('Service categorization breakdown');
    });

    return { serviceMap, uncategorizedRecords };
  }

  /**
   * Process all records by service type in parallel
   * @param serviceMap Map of service types to arrays of records
   * @returns Object containing batch item failures and their bodies
   */
  async processRecordsByService(
    serviceMap: Map<ServiceType, SQSRecord[]>
  ): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];
    
    // Process each service's records in parallel
    const results = await Promise.allSettled(
      Array.from(serviceMap.entries()).map(async ([serviceType, records]) => {
        log
          .info()
          .str('service', serviceType)
          .num('recordCount', records.length)
          .msg('Processing records for service type');
          
        try {
          // Special handling for EC2 records - batch processing
          if (serviceType === 'ec2' && records.length > 0) {
            const { failureResponse } = await this.processEC2Batch(records);
            
            if (failureResponse) {
              return {
                service: serviceType,
                failures: failureResponse
              };
            }
            return { service: serviceType, failures: null };
          } 
          
          // For all other service types, process records individually but in parallel
          const handler = this.getHandlerForService(serviceType);
          const serviceResults = await Promise.allSettled(
            records.map(async (record) => {
              try {
                // Parse record body
                const stringRecord = JSON.parse(record.body);
                
                // Process with the appropriate handler
                await handler(record);
                return null;
              } catch (error) {
                log
                  .error()
                  .str('service', serviceType)
                  .str('messageId', record.messageId)
                  .err(error)
                  .msg('Error processing record');
                  
                return {
                  itemIdentifier: record.messageId,
                  record
                };
              }
            })
          );
          
          // Collect failures for this service type
          const serviceFailures = serviceResults
            .filter((result): result is PromiseFulfilledResult<{itemIdentifier: string, record: SQSRecord}> => 
              result.status === 'fulfilled' && result.value !== null)
            .map(result => result.value!)
            .filter(Boolean);
            
          if (serviceFailures.length > 0) {
            return {
              service: serviceType,
              failures: {
                batchItemFailures: serviceFailures.map(f => ({ itemIdentifier: f.itemIdentifier })),
                batchItemBodies: serviceFailures.map(f => f.record)
              }
            };
          }
          
          return { service: serviceType, failures: null };
        } catch (error) {
          log
            .error()
            .str('service', serviceType)
            .err(error)
            .msg('Unhandled error processing service records');
            
          return {
            service: serviceType,
            failures: {
              batchItemFailures: records.map(r => ({ itemIdentifier: r.messageId })),
              batchItemBodies: records
            }
          };
        }
      })
    );
    
    // Collect all failures from different service types
    results
      .filter((result): result is PromiseFulfilledResult<{service: ServiceType, failures: SQSFailureResponse | null}> => 
        result.status === 'fulfilled' && result.value.failures !== null)
      .forEach(result => {
        if (result.value.failures) {
          batchItemFailures.push(...result.value.failures.batchItemFailures);
          batchItemBodies.push(...result.value.failures.batchItemBodies);
        }
      });
      
    // Also collect failures from rejected promises
    results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .forEach(result => {
        log
          .error()
          .err(result.reason)
          .msg('Service processing failed with unhandled error');
      });

    return { batchItemFailures, batchItemBodies };
  }

  /**
   * Process a single SQS record
   * @param record SQS record for logging and parsing as necessary
   * @param stringRecord Stringified version of the record for searching - we don't want to re-stringify the record every iteration over hundreds of invocations
   * @returns Promise that resolves when processing is complete
   * @deprecated Use the service-based batch processing with categorizeEvents and processRecordsByService
   */
  async processRecord(record: SQSRecord, stringRecord: string): Promise<void> {
    const handlerInfo = this.findHandler(record, stringRecord);

    if (!handlerInfo) {
      throw new Error(`No handler found for record ${record.messageId}`);
    }

    log
      .info()
      .str('service', handlerInfo.service)
      .str('messageId', record.messageId)
      .msg('Processing record with service handler');

    try {
      await handlerInfo.handler(record);
    } catch (error) {
      log
        .error()
        .str('service', handlerInfo.service)
        .str('messageId', record.messageId)
        .err(error)
        .msg('Error processing record with service handler');
      throw error;
    }
  }
}
