import {EC2Client, DescribeTagsCommand} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  PutMetricAlarmCommand,
  DeleteAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import {initialize} from '@nr1e/logging';
import {Handler, Context} from 'aws-lambda';

const ec2Client = new EC2Client({});
const cloudWatchClient = new CloudWatchClient({});

async function createAlarmForInstance(
  instanceId: string,
  log: any
): Promise<void> {
  const alarmName = `StatusCheckFailed_${instanceId}`;
  const putMetricAlarmParams = {
    AlarmName: alarmName,
    ComparisonOperator: 'GreaterThanThreshold' as const,
    EvaluationPeriods: 1,
    MetricName: 'StatusCheckFailed',
    Namespace: 'AWS/EC2',
    Period: 300,
    Statistic: 'Average' as const,
    Threshold: 0,
    ActionsEnabled: false,
    Dimensions: [{Name: 'InstanceId', Value: instanceId}],
  };

  await cloudWatchClient.send(new PutMetricAlarmCommand(putMetricAlarmParams));
  log
    .info()
    .str('alarmName', alarmName)
    .str('instanceId', instanceId)
    .msg('Created alarm');
}

async function deleteAlarmForInstance(
  instanceId: string,
  log: any
): Promise<void> {
  const alarmName = `StatusCheckFailed_${instanceId}`;
  await cloudWatchClient.send(
    new DeleteAlarmsCommand({AlarmNames: [alarmName]})
  );
  log
    .info()
    .str('msg', `Deleted alarm ${alarmName} for instance ${instanceId}`)
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
  response.Tags?.forEach(
    (tag: {Key?: string | undefined; Value?: string | undefined}) => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    }
  );
  return tags;
}

export const handler: Handler = async (
  event: any,
  context: Context
): Promise<void> => {
  const log = await initialize({
    svc: 'AutoAlarm',
    name: 'main-handler',
    level: 'trace',
  });

  log.trace().unknown('event', event).msg('Received event');
  try {
    if (event.source === 'aws.ec2') {
      const instanceId = event.detail['instance-id'];
      const state = event.detail.state;

      if (state === 'running') {
        const tags = await fetchInstanceTags(instanceId);
        if (tags['autoalarm:disabled'] !== 'true') {
          await createAlarmForInstance(instanceId, log);
        }
      } else if (state === 'terminated') {
        await deleteAlarmForInstance(instanceId, log);
      }
    } else if (event.source === 'aws.tag') {
      const resourceId = event.detail['resource-id'];
      const tags = await fetchInstanceTags(resourceId);
      if (tags['autoalarm:disabled'] === 'true') {
        await deleteAlarmForInstance(resourceId, log);
      }
    }
  } catch (e) {
    log.fatal().err(e).msg('Error processing event');
  }
};
