import {Handler} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {
  manageInactiveInstanceAlarms,
  manageActiveInstanceAlarms,
  getEC2IdAndState,
  fetchInstanceTags,
  liveStates,
  deadStates,
} from './ec2-modules.mjs';
import {ValidTargetGroupEvent, ValidOpenSearchState} from './enums.mjs';
import {parseALBEventAndCreateAlarms} from './alb-modules.mjs';
import {parseTGEventAndCreateAlarms} from './targetgroup-modules.mjs';
import {parseSQSEventAndCreateAlarms} from './sqs-modules.mjs';
import {
  fetchOpenSearchTags,
  manageOpenSearchAlarms,
  manageInactiveOpenSearchAlarms,
  getOpenSearchState,
} from './opensearch-modules.mjs';

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
    await manageActiveInstanceAlarms(instanceId, tags);
  } else if (
    (deadStates.has(state) && tags['autoalarm:enabled'] === 'false') ||
    (tags['autoalarm:enabled'] === 'true' && deadStates.has(state)) ||
    !tags['autoalarm:enabled']
  ) {
    // TODO Do not delete alarms just because the instance is shutdown. You do delete them on terminate.
    await manageInactiveInstanceAlarms(instanceId);
  }
}

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
    await manageActiveInstanceAlarms(instanceId, tags);
  } else if (!tags['autoalarm:enabled']) {
    log
      .info()
      .str('function', 'processEC2TagEvent')
      .msg('autoalarm:enabled tag not found. Skipping autoalarm processing');
  }
}

export async function processALBEvent(event: any) {
  await parseALBEventAndCreateAlarms(event);
}

export async function processTargetGroupEvent(event: any) {
  const eventName = event.detail.eventName;

  if (eventName === ValidTargetGroupEvent.Active) {
    parseTGEventAndCreateAlarms(event);
  }
}

export async function processSQSEvent(event: any) {
  await parseSQSEventAndCreateAlarms(event);
}

export async function processOpenSearchEvent(event: any) {
  const domainName = event.detail['domain-name'];
  const state = event.detail.state;
  const tags = await fetchOpenSearchTags(domainName);

  if (domainName && state === ValidOpenSearchState.Active) {
    await manageOpenSearchAlarms(domainName, tags);
  } else if (state === ValidOpenSearchState.Deleted) {
    await manageInactiveOpenSearchAlarms(domainName);
  }
}

export async function processOpenSearchTagEvent(event: any) {
  const {domainArn, state, tags} = await getOpenSearchState(event);

  if (tags['autoalarm:enabled'] === 'false') {
    await manageInactiveOpenSearchAlarms(domainArn);
  } else if (
    tags['autoalarm:enabled'] === 'true' &&
    domainArn &&
    state === ValidOpenSearchState.Active
  ) {
    await manageOpenSearchAlarms(domainArn, tags);
  }
}

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
  } else if (service === 'sqs') {
    await parseSQSEventAndCreateAlarms(event);
  } else if (service === 'es') {
    await processOpenSearchTagEvent(event);
  } else {
    log
      .warn()
      .msg(`Unhandled resource type or service: ${resourceType}, ${service}`);
  }
}

// Handler function
export const handler: Handler = async (event: any): Promise<void> => {
  log.trace().unknown('event', event).msg('Received event');

  try {
    switch (event.source) {
      case 'aws.ec2':
        await processEC2Event(event);
        break;
      case 'aws.tag':
        await routeTagEvent(event);
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
          log.warn().msg('Unhandled event name for aws.elasticloadbalancing');
        }
        break;
      case 'aws.sqs':
        await parseSQSEventAndCreateAlarms(event);
        break;
      case 'aws.opensearch':
        await processOpenSearchEvent(event);
        break;
      default:
        log.warn().msg('Unhandled event source');
        break;
    }
  } catch (error) {
    log.error().err(error).msg('Error processing event');
    throw error;
  }
};
