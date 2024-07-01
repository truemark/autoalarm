import {SQSClient, ListQueueTagsCommand} from '@aws-sdk/client-sqs';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types';
import {AlarmClassification, ValidSqsState} from './enums';
import {
  createOrUpdateCWAlarm,
  getCWAlarmsForInstance,
  deleteCWAlarm,
} from './alarm-tools';

const log: logging.Logger = logging.getRootLogger();
const sqsClient: SQSClient = new SQSClient({});

const defaultThresholds: {[key in AlarmClassification]: number} = {
  [AlarmClassification.Critical]: 1000,
  [AlarmClassification.Warning]: 500,
};

const metricConfigs = [
  {metricName: 'ApproximateNumberOfMessagesVisible', namespace: 'AWS/SQS'},
  {metricName: 'ApproximateAgeOfOldestMessage', namespace: 'AWS/SQS'},
];

async function getAlarmConfig(
  queueUrl: string,
  type: AlarmClassification,
  metricName: string
): Promise<{
  alarmName: string;
  thresholdKey: string;
  durationTimeKey: string;
  durationPeriodsKey: string;
}> {
  const thresholdKey = `autoalarm:${metricName}-percent-above-${type.toLowerCase()}`;
  const durationTimeKey = `autoalarm:${metricName}-percent-duration-time`;
  const durationPeriodsKey = `autoalarm:${metricName}-percent-duration-periods`;

  return {
    alarmName: `AutoAlarm-SQS-${queueUrl}-${type}-${metricName}`,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey,
  };
}

async function fetchSQSTags(queueUrl: string): Promise<Tag> {
  try {
    const command = new ListQueueTagsCommand({QueueUrl: queueUrl});
    const response = await sqsClient.send(command);
    const tags: Tag = response.Tags || {};

    log
      .info()
      .str('queueUrl', queueUrl)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched SQS tags');

    return tags;
  } catch (error) {
    log
      .error()
      .err(error)
      .str('queueUrl', queueUrl)
      .msg('Error fetching SQS tags');
    return {};
  }
}

export async function manageSQSAlarms(
  queueUrl: string,
  tags: Tag
): Promise<void> {
  for (const config of metricConfigs) {
    const {metricName, namespace} = config;
    for (const classification of Object.values(AlarmClassification)) {
      const {alarmName, thresholdKey, durationTimeKey, durationPeriodsKey} =
        await getAlarmConfig(
          queueUrl,
          classification as AlarmClassification,
          metricName
        );

      const alarmProps: AlarmProps = {
        threshold: defaultThresholds[classification as AlarmClassification],
        period: 60,
        namespace: namespace,
        evaluationPeriods: 5,
        metricName: metricName,
        dimensions: [{Name: 'QueueUrl', Value: queueUrl}],
      };

      await createOrUpdateCWAlarm(
        alarmName,
        queueUrl,
        alarmProps,
        tags,
        thresholdKey,
        durationTimeKey,
        durationPeriodsKey
      );
    }
  }
}

export async function manageInactiveSQSAlarms(queueUrl: string) {
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'sqs',
      queueUrl
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName => deleteCWAlarm(alarmName, queueUrl))
    );
  } catch (e) {
    log.error().err(e).msg(`Error deleting SQS alarms: ${e}`);
    throw new Error(`Error deleting SQS alarms: ${e}`);
  }
}

export async function processSQSEvent(event: any) {
  const queueUrl = event.detail['queue-url'];
  const state = event.detail.state;
  const tags = await fetchSQSTags(queueUrl);

  if (queueUrl && state === ValidSqsState.Active) {
    await manageSQSAlarms(queueUrl, tags);
  } else if (state === ValidSqsState.Deleted) {
    await manageInactiveSQSAlarms(queueUrl);
  }
}
