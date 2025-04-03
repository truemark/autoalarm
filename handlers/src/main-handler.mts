/**
 * AutoAlarm - Main Lambda Handler
 *
 * @module AutoAlarm
 *
 * @architecture
 * The system follows a factory/registry architecture:
 *
 * 1. ProcessorRegistry - Maintains a registry of service processor classes
 *    - Maps service types to their respective processor classes
 *    - Handles processor registration and instantiation
 *    - Provides a centralized repository of All Service Processors
 *
 * 2. ProcessorFactory - Creates and manages processor instances
 *    - Uses the registry to instantiate only when needed
 *    - Categorizes incoming records by service type
 *    - Coordinates parallel processing of records by service type
 *
 * 3. Service Processors - Handle service-specific processing logic
 *    - Each extends the abstract ServiceProcessor class
 *    - Service-specific implementations for processing SQS records
 *
 * @processing
 * Records are processed in two phases
 *
 * 1. Categorization Phase
 *    - Groups SQS records by AWS service type
 *    - Uses messageGroupId to intelligently route messages
 *    - Creates a map of service types to their respective records
 *
 * 2. Parallel Processing Phase
 *    - Processes each service type's records concurrently
 *    - Initializes processors only when needed to process records
 *    - Collects and consolidates failures across all processors
 *
 * @optimizations
 * A couple considerations and tricks:
 *
 * - Warm Starts: Processor instances can be reused across warm starts
 * - State Reset: We reset ProcessorFactory instances to avoid cross-invocation contamination across sequential invocations.
 *
 * @param {SQSEvent} event - SQS event containing up to 10 records to process
 * @returns {Promise<void|SQSBatchResponse>} - Returns batch failures for retry if any records couldn't be processed
 *
 * @example
 * // Sample event processing flow:
 * // 1. Lambda receives SQS event with 10 records (EC2:4, RDS:3, SQS:3)
 * // 2. Records are categorized by service
 * // 3. Processors for EC2, RDS, and SQS are instantiated
 * // 4. Records processed in parallel by service type
 * // 5. Any failures are individually returned for SQS retries
 *
 */

import {Handler, SQSBatchResponse, SQSEvent} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {ProcessorFactory} from './processor-factory.mjs';

// Initialize Logger
const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'main-handler',
  level,
});

// Initialize ProcessorFactory to initialize the processor registry map
const processorFactory = new ProcessorFactory();

export const handler: Handler = async (
  event: SQSEvent,
): Promise<void | SQSBatchResponse> => {
  try {
    // Reset the processor factory state to avoid cross-invocation bleed-over.
    processorFactory.reset();

    log
      .info()
      .str('function', 'handler')
      .num('recordCount', event.Records?.length || 0)
      .msg('Received SQS event batch');

    if (!event.Records || event.Records.length === 0) {
      log.debug().str('function', 'handler').msg('No records found in event');
      return;
    }

    // Phase 1: Categorize all records by service type
    const startTime = Date.now();

    // sorts the records into a map of {serviceType, records[]} to route to the appropriate processors
    const {serviceMap, uncategorizedRecords} =
      await processorFactory.categorizeRecords(event.Records);
    log
      .info()
      .str('function', 'handler')
      .num('categorizeTime', Date.now() - startTime)
      .num('serviceTypes', serviceMap.size)
      .num('uncategorizedCount', uncategorizedRecords.length)
      .msg('Record categorization complete');

    // Phase 2: Process all services in parallel
    const processingStartTime = Date.now();
    const {batchItemFailures, batchItemBodies} =
      await processorFactory.processRecordsByService(serviceMap);
    log
      .info()
      .str('function', 'handler')
      .num('processingTime', Date.now() - processingStartTime)
      .msg('Service-based batch processing complete');

    // Add any uncategorized records as failures
    if (uncategorizedRecords.length > 0) {
      log
        .warn()
        .str('function', 'handler')
        .num('uncategorizedCount', uncategorizedRecords.length)
        .msg('Adding uncategorized records to failure list');

      uncategorizedRecords.forEach((record) => {
        batchItemFailures.push({itemIdentifier: record.messageId});
        batchItemBodies.push(record);
      });
    }

    // Return failures if any were found
    if (batchItemFailures.length > 0) {
      log
        .warn()
        .str('function', 'handler')
        .num('failedItems', batchItemFailures.length)
        .num('totalItems', event.Records.length)
        .obj('failureDetails', batchItemFailures)
        .obj('failureDetails', batchItemBodies)
        .msg('Returning batch failures for retry');

      return {
        batchItemFailures,
      };
    }

    log
      .info()
      .str('function', 'handler')
      .num('totalTime', Date.now() - startTime)
      .num('recordCount', event.Records.length)
      .msg('Batch processing completed successfully');
  } catch (error) {
    // Catch any unhandled errors at the top level
    log
      .fatal()
      .str('function', 'handler')
      .err(error)
      .msg('Unhandled error in Lambda handler');
    throw error; // Rethrow for Lambda error handling
  }
};
