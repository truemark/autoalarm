import {Handler} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {
  manageInactiveInstanceAlarms,
  manageActiveEC2Alarms,
  getEC2IdAndState,
  fetchInstanceTags,
  liveStates,
  deadStates,
} from './ec2-modules.mjs';
import {parseALBEventAndCreateAlarms} from './alb-modules.mjs';
import {parseTGEventAndCreateAlarms} from './targetgroup-modules.mjs';
import {parseSQSEventAndCreateAlarms} from './sqs-modules.mjs';
import {parseOSEventAndCreateAlarms} from './opensearch-modules.mjs';
import {parseVpnEventAndCreateAlarms} from './vpn-modules.mjs';
import {parseR53ResolverEventAndCreateAlarms} from './route53-resolver-modules.mjs';
import {parseTransitGatewayEventAndCreateAlarms} from './transit-gateway-modules.mjs';
import {parseCloudFrontEventAndCreateAlarms} from './cloudfront-modules.mjs';
import {EC2AlarmManagerArray} from './types.mjs';

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

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processEC2Event(events: any[]): Promise<void> {
  const activeInstancesInfoArray: EC2AlarmManagerArray = [];
  const inactiveInstancesInfoArray: EC2AlarmManagerArray = [];

  for (const event of events) {
    const instanceId = event.detail['instance-id'];
    const state = event.detail.state;
    const tags = await fetchInstanceTags(instanceId);

    if (
      instanceId &&
      liveStates.has(state) &&
      tags['autoalarm:enabled'] === 'true'
    ) {
      activeInstancesInfoArray.push({
        instanceID: instanceId,
        tags: tags,
        state: state,
      });
    } else if (
      (deadStates.has(state) && tags['autoalarm:enabled'] === 'false') ||
      (tags['autoalarm:enabled'] === 'true' && deadStates.has(state)) ||
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
      await manageActiveEC2Alarms(activeInstancesInfoArray);
    }

    // If the instance is in a state that we should not be managing alarms for, we will remove the alarms.
    if (inactiveInstancesInfoArray.length > 0) {
      await manageInactiveInstanceAlarms(inactiveInstancesInfoArray);
    }
  }
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processEC2TagEvent(events: any[]) {
  const activeInstancesInfoArray: EC2AlarmManagerArray = [];
  const inactiveInstancesInfoArray: EC2AlarmManagerArray = [];
  for (const event of events) {
    const {instanceId, state} = await getEC2IdAndState(event);
    const tags = await fetchInstanceTags(instanceId);
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
      liveStates.has(state)
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
    await manageActiveEC2Alarms(activeInstancesInfoArray);
  }

  if (inactiveInstancesInfoArray.length > 0) {
    await manageInactiveInstanceAlarms(inactiveInstancesInfoArray);
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
      await parseTransitGatewayEventAndCreateAlarms(event);
      break;

    case 'vpn-connection':
      await parseVpnEventAndCreateAlarms(event);
      break;

    case 'elasticloadbalancing':
      switch (resourceType) {
        case 'loadbalancer':
          await parseALBEventAndCreateAlarms(event);
          break;

        case 'targetgroup':
          await parseTGEventAndCreateAlarms(event);
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
      await parseOSEventAndCreateAlarms(event);
      break;

    case 'route53resolver':
      await parseR53ResolverEventAndCreateAlarms(event);
      break;

    case 'cloudfront':
      await parseCloudFrontEventAndCreateAlarms(event);
      break;

    default:
      log
        .warn()
        .str('function', 'routeTagEvent')
        .msg(`Unhandled service: ${service}`);
      break;
  }
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler: Handler = async (event: any): Promise<void> => {
  log.trace().unknown('event', event).msg('Received event');
  // Create an array for all the EC2 events to be stored in and passed to the processEC2Event function imported form ec2-modules.mts
  // Still need to figure out type for event objects as they can vary from event to event
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ec2Events: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ec2TagEvents: any[] = [];

  try {
    if (event.Records) {
      for (const record of event.Records) {
        // Parse the body of the SQS message
        const event = JSON.parse(record.body);

        if (event.source === 'aws.ec2') {
          ec2Events.push(event);
        }

        log.trace().obj('body', event).msg('Processing message body');

        switch (event.source) {
          case 'aws.cloudfront':
            await parseCloudFrontEventAndCreateAlarms(event);
            break;

          case 'aws.elasticloadbalancing':
            if (
              event.detail.eventName === 'CreateLoadBalancer' ||
              event.detail.eventName === 'DeleteLoadBalancer'
            ) {
              await parseALBEventAndCreateAlarms(event);
            } else if (
              event.detail.eventName === 'CreateTargetGroup' ||
              event.detail.eventName === 'DeleteTargetGroup'
            ) {
              await parseTGEventAndCreateAlarms(event);
            } else {
              log
                .warn()
                .msg('Unhandled event name for aws.elasticloadbalancing');
            }
            break;

          case 'aws.opensearch':
            await parseOSEventAndCreateAlarms(event);
            break;

          case 'aws.route53resolver':
            await parseR53ResolverEventAndCreateAlarms(event);
            break;

          case 'aws.sqs':
            await parseSQSEventAndCreateAlarms(event);
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

          case 'transit-gateway':
            if (
              event.detail.eventName === 'CreateTransitGateway' ||
              event.detail.eventName === 'DeleteTransitGateway'
            ) {
              await parseTransitGatewayEventAndCreateAlarms(event);
            }
            break;

          case 'vpn-connection':
            if (
              event.detail.eventName === 'CreateVpnConnection' ||
              event.detail.eventName === 'DeleteVpnConnection'
            ) {
              await parseVpnEventAndCreateAlarms(event);
            }
            break;

          default:
            log.warn().msg(`Unhandled event source: ${event.source}`);
            break;
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

      // Else statement from initial if statement at the beginning of function.
    } else {
      log.warn().msg('No Records found in event');
    }
  } catch (error) {
    log.error().err(error).msg('Error processing event');
    throw error;
  }
};
