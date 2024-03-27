import {EC2Client, DescribeTagsCommand} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  PutMetricAlarmCommand,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {Handler, Context} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {Logger} from '@nr1e/logging';

const ec2Client = new EC2Client({});
const cloudWatchClient = new CloudWatchClient({});

async function doesAlarmExist(instanceId: string): Promise<boolean> {
  const alarmName = `StatusCheckFailed_${instanceId}`;
  const response = await cloudWatchClient.send(
    new DescribeAlarmsCommand({AlarmNames: [alarmName]})
  );
  return (response.MetricAlarms?.length ?? 0) > 0;
}

async function createAlarmForInstance(
  log: Logger,
  instanceId: string
): Promise<void> {
  const alarmName = `StatusCheckFailed_${instanceId}`; // Declare alarmName here
  const alarmExists = await doesAlarmExist(instanceId);
  if (!alarmExists) {
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
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Created alarm');
  } else {
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Alarm  already exists for instance');
  }
}

async function deleteAlarmForInstance(
  log: Logger,
  instanceId: string
): Promise<void> {
  const alarmName = `StatusCheckFailed_${instanceId}`;
  const alarmExists = await doesAlarmExist(instanceId);
  if (alarmExists) {
    await cloudWatchClient.send(
      new DeleteAlarmsCommand({AlarmNames: [alarmName]})
    );
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Deleted alarm');
  } else {
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceId)
      .msg('Alarm does not exist for instance');
  }
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
  const log = await logging.initialize({
    svc: 'AutoAlarm',
    name: 'main-handler',
    level: 'trace',
  });
  const sublog = logging.getLogger('ec2-tag-autoalarm', log);
  sublog.trace().unknown('context', context).msg('Received context');

  try {
    if (event.source === 'aws.ec2') {
      const instanceId = event.detail['instance-id'];
      const state = event.detail.state;
      sublog
        .info()
        .str('instanceId', instanceId)
        .str('state', state)
        .msg('Processing EC2 event');

      if (state === 'running') {
        const tags = await fetchInstanceTags(instanceId);
        sublog.info().str('tags', JSON.stringify(tags)).msg('Fetched tags');

        if (tags['autoalarm:disabled'] === 'true') {
          sublog.info().msg('autoalarm:disabled=true. Skipping alarm creation');
        } else if (tags['autoalarm:disabled'] === 'false') {
          await createAlarmForInstance(sublog, instanceId);
          sublog.info().msg('autoalarm:disabled=false');
        }
      } else if (state === 'terminated') {
        await deleteAlarmForInstance(sublog, instanceId);
      }
    } else if (event.source === 'aws.tag') {
      const resourceId = event.resources[0].split('/').pop();
      sublog.info().str('resourceId', resourceId).msg('Processing tag event');

      const tags = await fetchInstanceTags(resourceId);
      console.log(`Fetched tags for resource: ${resourceId}`, tags);

      if (tags['autoalarm:disabled'] === 'false') {
        await createAlarmForInstance(sublog, resourceId);
      } else if (tags['autoalarm:disabled'] === 'true') {
        await deleteAlarmForInstance(sublog, resourceId);
      }
    }
  } catch (e) {
    console.error('Error processing event', e);
    sublog.error().err(e).msg('Error processing event');
  }
};
