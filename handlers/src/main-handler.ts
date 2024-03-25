import {EC2Client, DescribeTagsCommand} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  PutMetricAlarmCommand,
  DeleteAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {Handler, Context} from 'aws-lambda';
import {initialize, Logger} from '@nr1e/logging';

const ec2Client = new EC2Client({});
const cloudWatchClient = new CloudWatchClient({});

// Initialize the logger
const logPromise: Promise<Logger> = initialize({
  svc: 'AutoAlarm',
  name: 'main-handler',
  level: 'trace',
});

async function createAlarmForInstance(
  instanceId: string,
  log: Logger
): Promise<void> {
  const alarmName = `StatusCheckFailed_${instanceId}`;
  await cloudWatchClient.send(
    new PutMetricAlarmCommand({
      AlarmName: alarmName,
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: 1,
      MetricName: 'StatusCheckFailed',
      Namespace: 'AWS/EC2',
      Period: 300,
      Statistic: 'Average',
      Threshold: 0,
      ActionsEnabled: false,
      Dimensions: [{Name: 'InstanceId', Value: instanceId}],
    })
  );
  log
    .info()
    .str('message', `Created alarm ${alarmName} for instance ${instanceId}`)
    .send();
}

async function deleteAlarmForInstance(
  instanceId: string,
  log: Logger
): Promise<void> {
  const alarmName = `StatusCheckFailed_${instanceId}`;
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({AlarmNames: [alarmName]})
  );
  log
    .info()
    .str('message', `Deleted alarm ${alarmName} for instance ${instanceId}`)
    .send();
}

async function fetchInstanceTags(
  instanceId: string
): Promise<{[key: string]: string}> {
  const response = await ec2Client.send(
    new DescribeTagsCommand({
      Filters: [{Name: 'resource-id', Values: [instanceId]}],
    })
  );
  const tags: {[key: string]: string} = {};
  response.Tags?.forEach(tag => {
    if (tag.Key && tag.Value) {
      tags[tag.Key] = tag.Value;
    }
  });
  return tags;
}

export const handler: Handler = async (
  event: any,
  context: Context
): Promise<void> => {
  let log: Logger; // Declare log with the correct Logger type

  try {
    log = await logPromise; // Now log is typed as Logger, not void or any
  } catch (error) {
    console.error('Error initializing logger', error);
    return; // Exit early if logger fails to initialize
  }

  log.info().unknown('event', event).str('message', 'Received event').send();

  try {
    if (event.source === 'aws.ec2') {
      const instanceId = event.detail['instance-id'];
      const state = event.detail.state;

      log
        .info()
        .str('instanceId', instanceId)
        .str('state', state)
        .str('message', 'Processing EC2 event')
        .send();

      if (state === 'running') {
        const tags = await fetchInstanceTags(instanceId);
        log.info().obj('tags', tags).send();

        if (tags['autoalarm:disabled'] !== 'true') {
          await createAlarmForInstance(instanceId, log);
        }
      } else if (state === 'terminated') {
        await deleteAlarmForInstance(instanceId, log);
      }
    } else if (event.source === 'aws.tag') {
      const resourceId = event.detail['resource-id'];
      const tags = await fetchInstanceTags(resourceId);
      log
        .info()
        .str('resourceId', resourceId)
        .obj('tags', tags)
        .str('message', 'Processing tag event')
        .send();

      if (tags['autoalarm:disabled'] === 'true') {
        await deleteAlarmForInstance(resourceId, log);
      }
    }
  } catch (e) {
    log.error().err(e).str('message', 'Error processing event').send();
  }
};
