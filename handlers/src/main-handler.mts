import {Handler, SQSEvent, SQSBatchResponse} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {manageEC2} from './ec2-modules.mjs';
import {parseALBEventAndCreateAlarms} from './alb-modules.mjs';
import {parseTGEventAndCreateAlarms} from './targetgroup-modules.mjs';
import {parseSQSEventAndCreateAlarms} from './sqs-modules.mjs';
import {parseOSEventAndCreateAlarms} from './opensearch-modules.mjs';
import {parseVpnEventAndCreateAlarms} from './vpn-modules.mjs';
import {parseR53ResolverEventAndCreateAlarms} from './route53-resolver-modules.mjs';
import {parseTransitGatewayEventAndCreateAlarms} from './transit-gateway-modules.mjs';
import {parseCloudFrontEventAndCreateAlarms} from './cloudfront-modules.mjs';
import {parseRDSEventAndCreateAlarms} from './rds-modules.mjs';
import {parseRDSClusterEventAndCreateAlarms} from './rds-cluster-modules.mjs';
import {parseSFNEventAndCreateAlarms} from './step-function-modules.mjs';
import {ProcessorRegistry} from './service-router.mjs';

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
 * Processor registry is initialized once and kept across Lambda invocations
 * This is a critical optimization for Lambda execution:
 *
 * 1. During cold start: The registry and all processors are initialized
 * 2. During warm invocations: The same registry instance is reused
 * 3. Before each invocation: The reset() method clears per-invocation state
 *
 * This pattern provides optimal performance by:
 * - Minimizing initialization overhead in warm starts
 * - Ensuring clean state between invocations
 * - Maintaining type-safe processors without recreating them
 */
// TODO: Some events do not use an ARN, we need to test each module and add the correct identifying for the relevant service identifiers
const processorRegistry = new ProcessorRegistry([
  {
    service: 'alb',
    identifiers: ['arn:aws:elasticloadbalancing:'],
    handler: parseALBEventAndCreateAlarms,
  },
  {
    service: 'cloudfront',
    identifiers: ['arn:aws:cloudfront:'],
    handler: parseCloudFrontEventAndCreateAlarms,
  },
  {
    service: 'ec2',
    identifiers: ['arn:aws:ec2:'],
    handler: manageEC2,
  },
  {
    service: 'opensearch',
    identifiers: ['arn:aws:es:'],
    handler: parseOSEventAndCreateAlarms,
  },
  {
    service: 'rds',
    identifiers: ['arn:aws:rds:'],
    handler: parseRDSEventAndCreateAlarms,
  },
  {
    service: 'rdscluster',
    identifiers: ['arn:aws:rds:cluster:'],
    handler: parseRDSClusterEventAndCreateAlarms,
  },
  {
    service: 'route53resolver',
    identifiers: ['arn:aws:route53resolver:'],
    handler: parseR53ResolverEventAndCreateAlarms,
  },
  {
    service: 'sqs',
    identifiers: ['arn:aws:sqs:'],
    handler: parseSQSEventAndCreateAlarms,
  },
  {
    service: 'sfn',
    identifiers: ['arn:aws:states:'],
    handler: parseSFNEventAndCreateAlarms,
  },
  {
    service: 'targetgroup',
    identifiers: ['arn:aws:elasticloadbalancing:targetgroup:'],
    handler: parseTGEventAndCreateAlarms,
  },
  {
    service: 'transitgateway',
    identifiers: ['arn:aws:ec2:transit-gateway:'],
    handler: parseTransitGatewayEventAndCreateAlarms,
  },
  {
    service: 'vpn',
    identifiers: ['arn:aws:ec2:vpn:'],
    handler: parseVpnEventAndCreateAlarms,
  },
]);

/**
 * Main Lambda handler for processing SQS events across multiple AWS services
 *
 * This function implements a two-phase processing approach:
 * 1. Categorize all records by service type (EC2, SQS, ALB, etc.)
 * 2. Process each service's records in parallel using the appropriate processor
 *
 * Key optimization features for AWS Lambda:
 * - State reset for warm starts to prevent cross-invocation contamination
 * - Batch processing where appropriate (EC2) to minimize API calls
 * - Parallel execution of independent service processing
 * - SQS partial batch failures for proper retry handling
 * - Comprehensive error tracking and reporting
 *
 * @param event The SQS event containing records to process (max 10 records per Lambda invocation)
 * @returns SQSBatchResponse with failures if any records couldn't be processed
 */
export const handler: Handler = async (
  event: SQSEvent,
): Promise<void | SQSBatchResponse> => {
  try {
    // Reset any per-invocation state to handle warm starts properly
    // This is critical in Lambda to avoid state bleeding between invocations
    processorRegistry.reset();

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
      await processorRegistry.categorizeRecords(event.Records);
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
      await processorRegistry.processRecordsByService(serviceMap);
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
