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
import {
  manageInactiveRDSAlarms,
  manageActiveRDSAlarms,
  liveStatesRDS,
  deadStatesRDS,
  getRDSIdAndState,
  fetchDBInstanceTags,
} from './rds-module';

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

  if (liveStates.has(state)) {
    await manageActiveInstanceAlarms(instanceId, tags);
  } else if (deadStates.has(state)) {
    await manageInactiveInstanceAlarms(instanceId);
  }
}

async function processRDSInstanceEvent(event: any) {
  const dbInstanceId = event.detail['DBInstanceIdentifier'];
  const state = event.detail.state;
  const tags = await fetchDBInstanceTags(dbInstanceId);

  if (liveStatesRDS.has(state)) {
    await manageActiveRDSAlarms(dbInstanceId, tags);
  } else if (deadStatesRDS.has(state)) {
    await manageInactiveRDSAlarms(dbInstanceId);
  }
}
async function processEC2TagEvent(event: any) {
  const {instanceId, state} = await getEC2IdAndState(event);
  //checking our liveStates set to see if the instance is in a state that we should be managing alarms for.
  if (instanceId && liveStates.has(state)) {
    const tags = await fetchInstanceTags(instanceId);
    await manageActiveInstanceAlarms(instanceId, tags);
  }
}

async function processRDSTagEvent(event: any) {
  const {dbInstanceId, state} = await getRDSIdAndState(event);
  //checking our liveStates set to see if the instance is in a state that we should be managing alarms for.
  if (dbInstanceId && liveStatesRDS.has(state)) {
    const tags = await fetchDBInstanceTags(dbInstanceId);
    await manageActiveRDSAlarms(dbInstanceId, tags);
  }
}

export const handler: Handler = async (event: any): Promise<void> => {
  await loggingSetup();
  log.trace().unknown('event', event).msg('Received event');
  try {
    switch (event.source) {
      case 'aws.ec2':
        await processEC2Event(event);
        break;
      case 'aws.rds':
        await processRDSInstanceEvent(event);
        break;
      case 'aws.tag':
        if (event.detail['instance-id']) {
          await processEC2TagEvent(event);
        } else if (event.detail['DBInstanceIdentifier']) {
          await processRDSTagEvent(event);
        } else {
          log.warn().msg('Tag event received without recognizable identifiers');
        }
        break;
      default:
        log.warn().msg('Unhandled event source');
        break;
    }
  } catch (error) {
    log.error().err(error).msg('Error processing event');
  }
};
