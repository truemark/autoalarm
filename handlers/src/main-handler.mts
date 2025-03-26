import {
  Handler,
  SQSEvent,
  SQSBatchResponse,
  SQSBatchItemFailure,
  SQSRecord,
} from 'aws-lambda';
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
import {eventSearch, ServiceRouter} from './service-router.mjs';
import {SQSFailureResponse} from './types.mjs';

// Initialize logging
const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'main-handler',
  level,
});

// Configure service handlers
const serviceRouter = new ServiceRouter([
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
    service: 'rds-cluster',
    identifiers: ['arn:aws:rds:cluster:'],
    handler: parseRDSClusterEventAndCreateAlarms,
  },
  {
    service: 'route53-resolver',
    identifiers: ['arn:aws:route53resolver:'],
    handler: parseR53ResolverEventAndCreateAlarms,
  },
  {
    service: 'sqs',
    identifiers: ['arn:aws:sqs:'],
    handler: parseSQSEventAndCreateAlarms,
  },
  {
    service: 'step-function',
    identifiers: ['arn:aws:states:'],
    handler: parseSFNEventAndCreateAlarms,
  },
  {
    service: 'targetgroup',
    identifiers: ['arn:aws:elasticloadbalancing:'],
    handler: parseTGEventAndCreateAlarms,
  },
  {
    service: 'transit-gateway',
    identifiers: ['arn:aws:ec2:transit-gateway:'],
    handler: parseTransitGatewayEventAndCreateAlarms,
  },
  {
    service: 'vpn',
    identifiers: ['arn:aws:ec2:vpn:'],
    handler: parseVpnEventAndCreateAlarms,
  },
]);

export const handler: Handler = async (
  event: SQSEvent,
): Promise<void | SQSBatchResponse> => {
  log.trace()
    .unknown('event', event)
    .num('recordCount', event.Records?.length || 0)
    .msg('Received SQS event batch');

  if (!event.Records || event.Records.length === 0) {
    log.warn().msg('No records found in event');
    return;
  }

  // Phase 1: Categorize all records by service type
  const startTime = Date.now();
  const { serviceMap, uncategorizedRecords } = await serviceRouter.categorizeEvents(event.Records);
  log.info()
    .num('categorizeTime', Date.now() - startTime)
    .num('serviceTypes', serviceMap.size)
    .msg('Record categorization complete');

  // Phase 2: Process all services in parallel, with each service handling its records appropriately
  const processingStartTime = Date.now();
  const { batchItemFailures, batchItemBodies } = await serviceRouter.processRecordsByService(serviceMap);
  log.info()
    .num('processingTime', Date.now() - processingStartTime)
    .msg('Service-based batch processing complete');
    
  // Add any uncategorized records as failures
  if (uncategorizedRecords.length > 0) {
    log.warn()
      .num('uncategorizedCount', uncategorizedRecords.length)
      .msg('Some records could not be categorized');
      
    uncategorizedRecords.forEach(record => {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      batchItemBodies.push(record);
    });
  }

  // Return failures if any were found
  if (batchItemFailures.length > 0) {
    log
      .error()
      .num('failedItems', batchItemFailures.length)
      .num('totalItems', event.Records.length)
      .msg('Batch processing completed with failures');
      
    // Only log detailed bodies at trace level as they could be large
    log
      .trace()
      .obj('batchItemBodies', batchItemBodies)
      .msg('Failed batch items');
      
    return {
      batchItemFailures
    };
  }
  
  log.info()
    .num('totalTime', Date.now() - startTime)
    .num('recordCount', event.Records.length)
    .msg('Batch processing completed successfully');
};
