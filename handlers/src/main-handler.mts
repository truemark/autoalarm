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
import {
  ValidTargetGroupEvent,
  ValidSqsEvent,
  ValidOpenSearchState,
} from './enums.mjs';
import {parseALBEventAndCreateAlarms} from './alb-modules.mjs';
import {
  fetchTargetGroupTags,
  manageTargetGroupAlarms,
  manageInactiveTargetGroupAlarms,
  getTargetGroupEvent,
} from './targetgroup-modules.mjs';
import {
  fetchSQSTags,
  manageSQSAlarms,
  manageInactiveSQSAlarms,
  getSqsEvent,
} from './sqs-modules.mjs';
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
    tags['autoalarm:disabled'] === 'false'
  ) {
    // checking our liveStates set to see if the instance is in a state that we should be managing alarms for.
    // we are iterating over the AlarmClassification enum to manage alarms for each classification: 'Critical'|'Warning'.
    await manageActiveInstanceAlarms(instanceId, tags);
  } else if (
    (deadStates.has(state) && tags['autoalarm:disabled'] === 'true') ||
    (tags['autoalarm:disabled'] === 'false' && deadStates.has(state)) ||
    !tags['autoalarm:disabled']
  ) {
    // TODO Do not delete alarms just because the instance is shutdown. You do delete them on terminate.
    await manageInactiveInstanceAlarms(instanceId);
  }
}

async function processEC2TagEvent(event: any) {
  const {instanceId, state} = await getEC2IdAndState(event);
  const tags = await fetchInstanceTags(instanceId);
  if (tags['autoalarm:disabled'] === 'true') {
    await manageInactiveInstanceAlarms(instanceId);
  } else if (
    tags['autoalarm:disabled'] === 'false' &&
    instanceId &&
    liveStates.has(state)
  ) {
    await manageActiveInstanceAlarms(instanceId, tags);
  } else if (!tags['autoalarm:disabled']) {
    log
      .info()
      .str('function', 'processEC2TagEvent')
      .msg('autoalarm:disabled tag not found. Skipping autoalarm processing');
  }
}

export async function processALBEvent(event: any) {
  await parseALBEventAndCreateAlarms(event);
}

export async function processTargetGroupEvent(event: any) {
  const eventName = event.detail.eventName;

  if (eventName === ValidTargetGroupEvent.Active) {
    const targetGroupArn =
      event.detail.responseElements?.targetGroups[0]?.targetGroupArn;
    const tags = await fetchTargetGroupTags(targetGroupArn);
    await manageTargetGroupAlarms(targetGroupArn, tags);
  } else if (eventName === ValidTargetGroupEvent.Deleted) {
    const targetGroupArn = event.detail.requestParameters?.targetGroupArn;
    await manageInactiveTargetGroupAlarms(targetGroupArn);
  }
}

export async function processTargetGroupTagEvent(event: any) {
  const {targetGroupArn, eventName, tags} = await getTargetGroupEvent(event);

  if (tags['autoalarm:disabled'] === 'true') {
    await manageInactiveTargetGroupAlarms(targetGroupArn);
  } else if (
    tags['autoalarm:disabled'] === 'false' &&
    targetGroupArn &&
    eventName === ValidTargetGroupEvent.Active
  ) {
    await manageTargetGroupAlarms(targetGroupArn, tags);
  }
}

export async function processSQSEvent(event: any) {
  const eventName = event.detail.eventName;
  if (eventName === ValidSqsEvent.CreateQueue) {
    const queueUrl = event.detail.responseElements.queueUrl;
    const tags = await fetchSQSTags(queueUrl);
    await manageSQSAlarms(queueUrl, tags);
  } else if (eventName === ValidSqsEvent.DeleteQueue) {
    const queueUrl = event.detail.requestParameters?.queueUrl;
    await manageInactiveSQSAlarms(queueUrl);
  }
}

export async function processSQSTagEvent(event: any) {
  const {queueUrl, eventName, tags} = await getSqsEvent(event);

  if (tags['autoalarm:disabled'] === 'true') {
    await manageInactiveSQSAlarms(queueUrl);
  } else if (
    tags['autoalarm:disabled'] === 'false' &&
    queueUrl &&
    eventName === ValidSqsEvent.CreateQueue
  ) {
    await manageSQSAlarms(queueUrl, tags);
  }
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

  if (tags['autoalarm:disabled'] === 'true') {
    await manageInactiveOpenSearchAlarms(domainArn);
  } else if (
    tags['autoalarm:disabled'] === 'false' &&
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
    } else if (resourceType === 'target-group') {
      await processTargetGroupTagEvent(event);
    }
  } else if (service === 'sqs') {
    await processSQSTagEvent(event);
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
          await processTargetGroupEvent(event);
        } else {
          log.warn().msg('Unhandled event name for aws.elasticloadbalancing');
        }
        break;
      case 'aws.sqs':
        await processSQSEvent(event);
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
