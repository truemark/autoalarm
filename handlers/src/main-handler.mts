import {Handler, SQSEvent, SQSBatchResponse} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {ProcessorFactory} from './processor-factory.mjs';

/**
 * Initialize logging with configurable level from environment variable
 */
const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'main-handler',
  level,
});

/**
 * Main Lambda handler for processing SQS events across multiple AWS services
 * The main handler is the entry point for AutoAlarm. It consists of:
 * - A Processor Registry which initializes "service processors" each handing events for a specific service.
 * -- Manages the routing of records to the appropriate processors based on service type
 *
 *  - A handler that implements a two-phase processing approach:
 * 1. Categorize all records by service type (EC2, SQS, ALB, etc.) via the `categorizeRecords` method of the `ProcessorFactory` class.
 * 2. Process each service's records in parallel using the appropriate processor via the `processRecordsByService` method of the `ProcessorFactory`.
 *
 * Key optimization features for AWS Lambda:
 * - **Processor Registry**: Consolidates service management and routing. initialized outside the handler for warm start optimization.
 * - **State Management**: Resets state at the beginning of each invocation to prevent cross-invocation contamination (warm starts).
 * -- See line 50 here and line 126 in processor-factory.mts for the reset method.
 * - Batch processing to mitigate the number of calls to AWS APIs.
 * - **Concurrent Processing**: Concurrently processes all events.
 * - **SQS Message Failure Handling**: Returns a list of individual failed items in place of retrying an entire batch.
 *
 * @param event The SQS event containing records to process (max 10 records per Lambda invocation)
 * @returns SQSBatchResponse with failures if any records couldn't be processed
 */

const processorFactory = new ProcessorFactory()

export const handler: Handler = async (
  event: SQSEvent,
): Promise<void | SQSBatchResponse> => {
  try {
    // Reset any per-invocation state to handle warm starts properly
    // This is critical in Lambda to avoid state bleeding between invocations
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
        .warn() // Changed from error to warn as this is an expected condition
        .str('function', 'handler')
        .num('failedItems', batchItemFailures.length)
        .num('totalItems', event.Records.length)
        .msg('Returning batch failures for retry');

      log
        .trace()
        .str('function', 'handler')
        .obj('batchItemBodies', batchItemBodies)
        .msg('Failed batch items');

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
      .error()
      .str('function', 'handler')
      .err(error)
      .msg('Unhandled error in Lambda handler');
    throw error; // Rethrow for Lambda error handling
  }
};
