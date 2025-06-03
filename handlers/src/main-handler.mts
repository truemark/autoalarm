import {
  Handler,
  SQSEvent,
  SQSBatchResponse,
  SQSBatchItemFailure,
  SQSRecord,
} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import * as ServiceModules from './service-modules/_index.mjs'; // TODO: we need to fix the import when we transition to
//  static utility classes with an import for each module
import {SecManagerPrometheusModule} from './service-modules/_index.mjs';
import {EC2AlarmManagerArray, ServiceEventMap} from './types/index.mjs';
import {EventParse} from './service-modules/utils/event-parser.mjs';

// Initialize logging
//TODO: maybe initialize logging in src so we can get child loggers across all modules
const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}
const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'main-handler',
  level,
});

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processEC2Event(events: any[]): Promise<void> {
  const activeInstancesInfoArray: EC2AlarmManagerArray = [];
  const inactiveInstancesInfoArray: EC2AlarmManagerArray = [];

  for (const event of events) {
    const instanceId = event.detail['instance-id'];
    const state = event.detail.state;
    const tags = await ServiceModules.fetchInstanceTags(instanceId);

    if (
      instanceId &&
      ServiceModules.liveStates.has(state) &&
      tags['autoalarm:enabled'] === 'true'
    ) {
      activeInstancesInfoArray.push({
        instanceID: instanceId,
        tags: tags,
        state: state,
      });
    } else if (
      (ServiceModules.deadStates.has(state) &&
        tags['autoalarm:enabled'] === 'false') ||
      (tags['autoalarm:enabled'] === 'true' &&
        ServiceModules.deadStates.has(state)) ||
      !tags['autoalarm:enabled']
    ) {
      inactiveInstancesInfoArray.push({
        instanceID: instanceId,
        tags: tags,
        state: state,
      });
    }
    // checking our liveStates set to see if the instance is in a state that we should be managing alarms for.
    // we are iterating over the AlarmClassification enum to manage alarms for each classification: 'Critical'|'Warning'.
    if (activeInstancesInfoArray.length > 0) {
      await ServiceModules.manageActiveEC2InstanceAlarms(
        activeInstancesInfoArray,
      );
    }

    // If the instance is in a state that we should not be managing alarms for, we will remove the alarms.
    if (inactiveInstancesInfoArray.length > 0) {
      await ServiceModules.manageInactiveInstanceAlarms(
        inactiveInstancesInfoArray,
      );
    }
  }
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processEC2TagEvent(events: any[]) {
  const activeInstancesInfoArray: EC2AlarmManagerArray = [];
  const inactiveInstancesInfoArray: EC2AlarmManagerArray = [];
  for (const event of events) {
    const {instanceId, state} = await ServiceModules.getEC2IdAndState(event);
    const tags = await ServiceModules.fetchInstanceTags(instanceId);
    if (tags['autoalarm:enabled'] === 'false') {
      inactiveInstancesInfoArray.push({
        instanceID: instanceId,
        tags: tags,
        state: state,
      });
      log
        .info()
        .str('function', 'processEC2TagEvent')
        .str('instanceId', instanceId)
        .str('autoalarm:enabled', tags['autoalarm:enabled'])
        .msg(
          'autoalarm:enabled tag set to false. Adding to inactiveInstancesInfoArray for alarm deletion',
        );
    } else if (
      tags['autoalarm:enabled'] === 'true' &&
      instanceId &&
      ServiceModules.liveStates.has(state)
    ) {
      activeInstancesInfoArray.push({
        instanceID: instanceId,
        tags: tags,
        state: state,
      });
    } else if (
      !tags['autoalarm:enabled'] ||
      tags['autoalarm:enabled'] === undefined
    ) {
      inactiveInstancesInfoArray.push({
        instanceID: instanceId,
        tags: tags,
        state: state,
      });
      log
        .info()
        .str('function', 'processEC2TagEvent')
        .str('instanceId', instanceId)
        .msg(
          'autoalarm:enabled tag not found. Adding to inactiveInstancesInfoArray for alarm deletion',
        );
    }
  }

  if (activeInstancesInfoArray.length > 0) {
    try {
      await ServiceModules.manageActiveEC2InstanceAlarms(
        activeInstancesInfoArray,
      );
    } catch (error) {
      log.error().err(error).msg('Error managing active EC2 instance alarms');
      throw new Error('Error managing active EC2 instance alarms');
    }
  }

  if (inactiveInstancesInfoArray.length > 0) {
    try {
      await ServiceModules.manageInactiveInstanceAlarms(
        inactiveInstancesInfoArray,
      );
    } catch (error) {
      log.error().err(error).msg('Error managing inactive EC2 instance alarms');
      throw new Error('Error managing inactive EC2 instance alarms');
    }
  }
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function routeTagEvent(event: any) {
  const detail = event.detail;
  const resourceType = detail['resource-type'];
  const service = detail.service;

  log
    .info()
    .str('function', 'routeTagEvent')
    .str('resourceType', resourceType)
    .str('service', service)
    .msg('Processing tag event');

  switch (service) {
    case 'transit-gateway':
      await ServiceModules.parseTransitGatewayEventAndCreateAlarms(event);
      break;

    case 'vpn-connection':
      await ServiceModules.parseVpnEventAndCreateAlarms(event);
      break;

    case 'elasticloadbalancing':
      switch (resourceType) {
        case 'loadbalancer':
          await ServiceModules.parseALBEventAndCreateAlarms(event);
          break;

        case 'targetgroup':
          await ServiceModules.parseTGEventAndCreateAlarms(event);
          break;

        default:
          log
            .warn()
            .str('function', 'routeTagEvent')
            .msg(`Unhandled resource type for ELB: ${resourceType}`);
          break;
      }
      break;

    case 'es':
      await ServiceModules.parseOSEventAndCreateAlarms(event);
      break;

    case 'route53resolver':
      await ServiceModules.parseR53ResolverEventAndCreateAlarms(event);
      break;

    case 'cloudfront':
      await ServiceModules.parseCloudFrontEventAndCreateAlarms(event);
      break;

    case 'rds':
      if (resourceType === 'cluster') {
        await ServiceModules.parseRDSClusterEventAndCreateAlarms(event);
      } else if (resourceType === 'db') {
        await ServiceModules.parseRDSEventAndCreateAlarms(event);
      } else {
        log.warn().msg(`Unhandled RDS resource: ${resourceType}`);
      }
      break;

    case 'states':
      await ServiceModules.parseSFNEventAndCreateAlarms(event);
      break;

    default:
      log
        .warn()
        .str('function', 'routeTagEvent')
        .msg(`Unhandled service: ${service}`);
      break;
  }
}

export const handler: Handler = async (
  event: SQSEvent,
): Promise<void | SQSBatchResponse> => {
  log.trace().unknown('event', event).msg('Received event');
  // Create an array for all the EC2 events to be stored in and passed to the processEC2Event function imported form ec2-modules.mts
  // Still need to figure out type for event objects as they can vary from event to event
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ec2Events: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ec2TagEvents: any[] = [];
  /**
   * Create batch item failures array to store any failed items from the batch.
   */
  const batchItemFailures: SQSBatchItemFailure[] = [];
  const batchItemBodies: SQSRecord[] = [];

  if (!event.Records) {
    log.warn().msg('No Records found in event');
    throw new Error('No Records found in event');
  }

  for (const record of event.Records) {
    // Check if the record body contains an error message
    if (record.body && record.body.includes('errorMessage')) {
      log
        .warn()
        .str('messageId', record.messageId)
        .msg('Error message found in record body');
      continue;
    }

    /**
     * TODO: for testing with new filtering logic. For prometheus secrets manager events only.
     *  Start of new Main Handler logic.
     *  @info This event map object will be extended to include all services but in this version,
     * it only includes secrets manager events for prometheus alarm management.
     *
     */
    const EventMap: ServiceEventMap = {
      ...SecManagerPrometheusModule.SecretsManagerEventMap,
    } as const;

    // Initialize the EventParse class with the event map and the record
    const parser = new EventParse(EventMap);

    // check if the event matches the event map for prometheus secrets manager events returns undefined if no match is found
    const eventMatch = await parser.matchEvent(record);

    // If the event matches the event map, manage the alarms using the SecManagerPrometheusModule otherwise set isSuccesful to false
    const isSuccesful = eventMatch
      ? await SecManagerPrometheusModule.manageDbAlarms(
          eventMatch?.isDestroyed,
          eventMatch?.tags,
          eventMatch?.isARN,
          eventMatch?.id,
        )
      : false;

    // If the event does not match the event map or SecManagerPrometheusModule was unsuccessful, log an error and continue to the next record
    if (!isSuccesful) {
      log
        .error()
        .str('function', 'handler')
        .str('messageId', record.messageId)
        .msg(
          'Event did not match the event map or SecManagerPrometheusModule was unsuccessful',
        );
      batchItemFailures.push({itemIdentifier: record.messageId});
      batchItemBodies.push(record);
      continue;
    }
    /**
     * TODO: End of new Main Handler logic. for prometheus secrets manager events integration.
     *
     *
     * @END
     */

    // Parse the body of the SQS message
    const event = JSON.parse(record.body);

    log.trace().obj('body', event).msg('Processing message body');
    try {
      switch (event.source) {
        case 'aws.cloudfront':
          await ServiceModules.parseCloudFrontEventAndCreateAlarms(event);
          break;
        case 'aws.ec2':
          log
            .debug()
            .str('function', 'handler')
            .obj('eventDetail', event.detail)
            .str('resourceType', JSON.stringify(event.detail))
            .msg('Processing EC2 event');

          // Check for EC2 Instance State-change Notification based on detail-type
          if (
            event['detail-type'] === 'EC2 Instance State-change Notification'
          ) {
            ec2Events.push(event);
          } else if (event.detail && event.detail.resourceType) {
            // Handle other EC2 events that have a resourceType defined
            switch (event.detail.resourceType) {
              case 'instance':
                ec2Events.push(event);
                break;
              case 'transit-gateway':
                if (
                  event.detail.eventName === 'CreateTransitGateway' ||
                  event.detail.eventName === 'DeleteTransitGateway'
                )
                  await ServiceModules.parseTransitGatewayEventAndCreateAlarms(
                    event,
                  );
                break;
              case 'vpn-connection':
                if (
                  event.detail.eventName === 'CreateVpnConnection' ||
                  event.detail.eventName === 'DeleteVpnConnection'
                )
                  await ServiceModules.parseVpnEventAndCreateAlarms(event);
                break;
              default:
                log
                  .error()
                  .msg(
                    `Unhandled resource type for aws.ec2: ${event.detail.resourceType}`,
                  );
                batchItemFailures.push({itemIdentifier: record.messageId});
                batchItemBodies.push(record);
                break;
            }
          } else {
            log.error().msg('Unhandled EC2 event format');
            batchItemFailures.push({itemIdentifier: record.messageId});
            batchItemBodies.push(record);
          }
          break;
        case 'aws.elasticloadbalancing':
          if (
            event.detail.eventName === 'CreateLoadBalancer' ||
            event.detail.eventName === 'DeleteLoadBalancer'
          ) {
            await ServiceModules.parseALBEventAndCreateAlarms(event);
          } else if (
            event.detail.eventName === 'CreateTargetGroup' ||
            event.detail.eventName === 'DeleteTargetGroup'
          ) {
            await ServiceModules.parseTGEventAndCreateAlarms(event);
          } else {
            log
              .error()
              .msg('Unhandled event name for aws.elasticloadbalancing');
            batchItemFailures.push({itemIdentifier: record.messageId});
            batchItemBodies.push(record);
          }
          break;

        case 'aws.opensearch':
          await ServiceModules.parseOSEventAndCreateAlarms(event);
          break;

        case 'aws.rds':
          if (
            event.detail.eventName === 'CreateDBInstance' ||
            event.detail.eventName === 'DeleteDBInstance'
          ) {
            await ServiceModules.parseRDSEventAndCreateAlarms(event);
          } else if (
            event.detail.eventName === 'CreateDBCluster' ||
            event.detail.eventName === 'DeleteDBCluster'
          ) {
            await ServiceModules.parseRDSClusterEventAndCreateAlarms(event);
          } else {
            log.error().msg('Unhandled event name for aws.rds');
            batchItemFailures.push({itemIdentifier: record.messageId});
            batchItemBodies.push(record);
          }
          break;

        case 'aws.route53resolver':
          await ServiceModules.parseR53ResolverEventAndCreateAlarms(event);
          break;

        case 'aws.sqs':
          await ServiceModules.parseSQSEventAndCreateAlarms(event);
          break;

        case 'aws.states':
          await ServiceModules.parseSFNEventAndCreateAlarms(event);
          break;

        case 'aws.tag':
          // add ec2 tag events to another array for processing.
          if (
            (event.detail.service === 'ec2' ||
              event.detail.service === 'aws.ec2') &&
            event.detail['resource-type'] === 'instance'
          ) {
            ec2TagEvents.push(event);
          } else {
            await routeTagEvent(event);
          }
          break;

        default:
          log.warn().msg(`Unhandled event source: ${event.source}`);
          batchItemFailures.push({itemIdentifier: record.messageId});
          batchItemBodies.push(record);
          break;
      }
    } catch (error) {
      log.error().err(error).msg('Error processing event');
      batchItemFailures.push({itemIdentifier: record.messageId});
      batchItemBodies.push(record);
    }
  }

  // If there were EC2 events after all iterations of the event records from the for loop, process them
  if (ec2Events.length > 0) {
    await processEC2Event(ec2Events);
  }

  // If there were EC2 tag events after all iterations of the event records from the for loop, process them
  if (ec2TagEvents.length > 0) {
    await processEC2TagEvent(ec2TagEvents);
  }

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
