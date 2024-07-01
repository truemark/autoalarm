import {Handler} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {
  manageInactiveInstanceAlarms,
  manageActiveInstanceAlarms,
  getEC2IdAndState,
  fetchInstanceTags,
  liveStates,
  deadStates,
} from './ec2-modules';

const log = logging.getRootLogger();

async function loggingSetup() {
  try {
    await logging.initialize({
      svc: 'AutoAlarm',
      name: 'main-handler',
      level: 'trace',
    });
  } catch (error) {
    // Fallback logging initialization (e.g., to console)
    console.error('Failed to initialize custom logger:', error);
    throw new Error(`Failed to initialize custom logger: ${error}`);
  }
}

async function processEC2Event(event: any) {
  const instanceId = event.detail['instance-id'];
  const state = event.detail.state;
  const tags = await fetchInstanceTags(instanceId);

  if (instanceId && liveStates.has(state)) {
    //checking our liveStates set to see if the instance is in a state that we should be managing alarms for.
    //we are iterating over the AlarmClassification enum to manage alarms for each classification: 'Critical'|'Warning'.

    await manageActiveInstanceAlarms(instanceId, tags);
  } else if (deadStates.has(state)) {
    // TODO Do not delete alarms just because the instance is shutdown. You do delete them on terminate.
    await manageInactiveInstanceAlarms(instanceId);
  }
}

async function processTagEvent(event: any) {
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
  }
}

// Handler function
export const handler: Handler = async (event: any): Promise<void> => {
  await loggingSetup();
  log.trace().unknown('event', event).msg('Received event');

  try {
    switch (event.source) {
      case 'aws.ec2':
        await processEC2Event(event);
        break;
      case 'aws.tag':
        await processTagEvent(event);
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
