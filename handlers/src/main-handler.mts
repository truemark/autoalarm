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
import {ValidTargetGroupEvent} from './enums.mjs';
import {parseALBEventAndCreateAlarms} from './alb-modules.mjs';
import {parseTGEventAndCreateAlarms} from './targetgroup-modules.mjs';
import {parseSQSEventAndCreateAlarms} from './sqs-modules.mjs';
import {parseOSEventAndCreateAlarms} from './opensearch-modules.mjs';

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
async function processEC2Event(event: any) {
  const instanceId = event.detail['instance-id'];
  const state = event.detail.state;
  const tags = await fetchInstanceTags(instanceId);

  if (
    instanceId &&
    liveStates.has(state) &&
    tags['autoalarm:enabled'] === 'true'
  ) {
    // checking our liveStates set to see if the instance is in a state that we should be managing alarms for.
    // we are iterating over the AlarmClassification enum to manage alarms for each classification: 'Critical'|'Warning'.
    await manageActiveEC2Alarms(instanceId, tags);
  } else if (
    (deadStates.has(state) && tags['autoalarm:enabled'] === 'false') ||
    (tags['autoalarm:enabled'] === 'true' && deadStates.has(state)) ||
    !tags['autoalarm:enabled']
  ) {
    // TODO Do not delete alarms just because the instance is shutdown. You do delete them on terminate.
    await manageInactiveInstanceAlarms(instanceId);
  }
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processEC2TagEvent(event: any) {
  const {instanceId, state} = await getEC2IdAndState(event);
  const tags = await fetchInstanceTags(instanceId);
  if (tags['autoalarm:enabled'] === 'false') {
    await manageInactiveInstanceAlarms(instanceId);
  } else if (
    tags['autoalarm:enabled'] === 'true' &&
    instanceId &&
    liveStates.has(state)
  ) {
    await manageActiveEC2Alarms(instanceId, tags);
  } else if (
    !tags['autoalarm:enabled'] ||
    tags['autoalarm:enabled'] === undefined
  ) {
    log
      .info()
      .str('function', 'processEC2TagEvent')
      .msg('autoalarm:enabled tag not found. Skipping autoalarm processing');
  }
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function processALBEvent(event: any) {
  await parseALBEventAndCreateAlarms(event);
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function processTargetGroupEvent(event: any) {
  const eventName = event.detail.eventName;

  if (eventName === ValidTargetGroupEvent.Active) {
    await parseTGEventAndCreateAlarms(event);
  }
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function processSQSEvent(event: any) {
  await parseSQSEventAndCreateAlarms(event);
}

// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function routeTagEvent(event: any) {
  const detail = event.detail;
  const resourceType = detail['resource-type'];
  const service = detail.service;

  if (resourceType === 'instance') {
    await processEC2TagEvent(event);
  } else if (service === 'elasticloadbalancing') {
    if (resourceType === 'loadbalancer') {
      await parseALBEventAndCreateAlarms(event);
    } else if (resourceType === 'targetgroup') {
      await parseTGEventAndCreateAlarms(event);
    }
  } else if (service === 'es') {
    await parseOSEventAndCreateAlarms(event);
  } else {
    log
      .warn()
      .msg(`Unhandled resource type or service: ${resourceType}, ${service}`);
  }
}

// Handler function
// TODO Fix the use of any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler: Handler = async (event: any): Promise<void> => {
  log.trace().unknown('event', event).msg('Received event');

  try {
    if (event.Records) {
      for (const record of event.Records) {
        // Parse the body of the SQS message
        const body = JSON.parse(record.body);

        log.trace().obj('body', body).msg('Processing message body');

        switch (body.source) {
          case 'aws.ec2':
            await processEC2Event(body);
            break;
          case 'aws.tag':
            await routeTagEvent(body);
            break;
          case 'aws.elasticloadbalancing':
            if (
              body.detail.eventName === 'CreateLoadBalancer' ||
              body.detail.eventName === 'DeleteLoadBalancer'
            ) {
              await parseALBEventAndCreateAlarms(body);
            } else if (
              body.detail.eventName === 'CreateTargetGroup' ||
              body.detail.eventName === 'DeleteTargetGroup'
            ) {
              await parseTGEventAndCreateAlarms(body);
            } else {
              log
                .warn()
                .msg('Unhandled event name for aws.elasticloadbalancing');
            }
            break;
          case 'aws.sqs':
            await parseSQSEventAndCreateAlarms(body);
            break;
          case 'aws.opensearch':
            await parseOSEventAndCreateAlarms(body);
            break;
          default:
            log.warn().msg(`Unhandled event source: ${body.source}`);
            break;
        }
      }
    } else {
      log.warn().msg('No Records found in event');
    }
  } catch (error) {
    log.error().err(error).msg('Error processing event');
    throw error;
  }
};
