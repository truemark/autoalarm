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
import {AlarmManagerEnumberation} from './enums.mjs';
import {rejects} from 'node:assert';
import {AsycnAlarmManagerMap} from "./types.mjs";

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

/**
 * Helper function to agnosticly, dynamically and linearly search for resource identifiers or other data needed to route events.
 * @param record<T> This is the SQS record that contains the event data or other object type.
 * @param indexStart use a universal string preamble to categorically search for the start of the strings you are looking for.
 * @param indexEnd Use this as the last delimiter that separates your desired string and the next index after your string. Usually '"'
 * @returns string
 *
 */
function eventSearch<T>(
  record: T,
  indexStart: string,
  indexEnd: string,
): string {
  const recordString: string = JSON.stringify(record);

  const startIndex: number = recordString.indexOf(indexStart);
  if (startIndex === -1) {
    log
      .error()
      .str('function', 'eventSearch')
      .str('indexStart', indexStart)
      .msg('Event search failed for indexStart');
    return '';
  }

  const endIndex: number = recordString.indexOf(indexEnd, startIndex);
  if (endIndex === -1) {
    log
      .error()
      .str('function', 'eventSearch')
      .str('indexEnd', indexStart)
      .msg('Event search failed for indexEnd');
    return '';
  }

  return recordString.substring(startIndex, endIndex);
}

// Build a map with keys related to each service and then call the appropriate function to handle the event
const asyncAlarmManagerMap: AsycnAlarmManagerMap = {
  'alb': parseALBEventAndCreateAlarms,
  'cloudfront': parseCloudFrontEventAndCreateAlarms,
  'opensearch': parseOSEventAndCreateAlarms,
  'rds': parseRDSEventAndCreateAlarms,
  'rds-cluster': parseRDSClusterEventAndCreateAlarms,
  'route53-resolver': parseR53ResolverEventAndCreateAlarms,
  'sqs': parseSQSEventAndCreateAlarms,
  'step-function': parseSFNEventAndCreateAlarms,
  'targetgroup': parseTGEventAndCreateAlarms,
  'transit-gateway': parseTransitGatewayEventAndCreateAlarms,
  'vpn': parseVpnEventAndCreateAlarms,
};

//concurrently parse all the events and call the proper function to handle the event

// TODO: we are going to use promise.race to perform asynchronous linear search across a map of all these payloads instead of looping and casing everything. It's terrible and I hate it.
export const handler: Handler = async (
  event: SQSEvent,
): Promise<void | SQSBatchResponse> => {
  log.trace().unknown('event', event).msg('Received event');
  /**
   * Create batch item failures array to store any failed items from the batch.
   */
  const batchItemFailures: SQSBatchItemFailure[] = [];
  const batchItemBodies: SQSRecord[] = [];
  const ec2InstanceMap: Record<string, SQSRecord>[] = [];


  /**
   * Check if we have any EC2 events in the interim and get the instance IDs. W'll clean up teh logic when we consolidate the modules into a single module.
   */
  await Promise.allSettled(
    event.Records.map(async (record) => {
      const searchResult: string | undefined = eventSearch(record, 'arn:aws:ec2:', '"').split('/').pop()!
      if (searchResult) {
        ec2InstanceMap.push({[searchResult]: record});
      }
    }),
  );

  if (ec2InstanceMap.length > 0) {
    log
      .trace()
      .num('instanceIDs', ec2InstanceMap.length)
      .msg('Instance IDs found in event');
    try {
      await manageEC2(ec2InstanceMap);
    } catch (error) {
      batchItemFailures.push({itemIdentifier: ec2InstanceMap[searchResult]});
      log.error().msg('Error processing EC2 event');
      return;
    }
  }

  /**
   * Initialize function key to store the key of the function that will be called to handle the event
   */
  let functionKey: string;


  if (!event.Records) {
    log.warn().msg('No Records found in event');
    throw new Error('No Records found in event');
  }

  /**
   * Process all the events concurrently and call the proper function to handle each event
   */
  await Promise.allSettled(
    event.Records.map(async (record) => {
      try {
        try {
          functionKey = await Promise.any(
            Object.keys(asyncAlarmManagerMap).map(async (key) => {
              const result = eventSearch(
                record,
                AlarmManagerEnumberation[
                  `${key as keyof typeof AlarmManagerEnumberation}`
                ],
                '"',
              );
              if (result) return key;
              throw new Error('No match found');
            }),
          );
        } catch (error) {
          log
            .error()
            .str('messageId', record.messageId)
            .msg('Could not determine service type from event');
          batchItemFailures.push({itemIdentifier: record.messageId});
          batchItemBodies.push(record);
          return;
        }
      } catch (error) {
        log
          .error()
          .str('messageId', record.messageId)
          .msg('Error processing event');
        batchItemFailures.push({itemIdentifier: record.messageId});
        batchItemBodies.push(record);
        return;
      }

      // Now that we have the proper key, we can call teh correct function;

      try {
        await asyncAlarmManagerMap[functionKey](record);
      } catch (error) {
        log
          .error()
          .str('messageId', record.messageId)
          .msg('Error processing event');
        batchItemFailures.push({itemIdentifier: record.messageId});
        batchItemBodies.push(record);
        return;
      }
    }),
  );

  if (batchItemFailures.length > 0) {
    log
      .error()
      .str('function', 'handler')
      .num('failedItems', batchItemFailures.length)
      .msg('Batch item failures found');
    log
      .error()
      .obj('batchItemBodies', batchItemBodies)
      .msg('Batch item bodies');
    return {
      batchItemFailures: batchItemFailures,
    };
  }
};
