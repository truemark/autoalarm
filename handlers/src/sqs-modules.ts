import {SQSClient, ListQueueTagsCommand} from '@aws-sdk/client-sqs';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types';
import {AlarmClassification, ValidSqsEvent} from './enums';
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

function extractQueueName(queueUrl: string): string {
  const parts = queueUrl.split('/');
  return parts[parts.length - 1];
}

async function getAlarmConfig(
  queueName: string,
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
    alarmName: `AutoAlarm-SQS-${queueName}-${type}-${metricName}`,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey,
  };
}

export async function fetchSQSTags(queueUrl: string): Promise<Tag> {
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

async function checkAndManageSQSStatusAlarms(queueUrl: string, tags: Tag) {
  const queueName = extractQueueName(queueUrl);
  if (tags['autoalarm:disabled'] === 'true') {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'SQS',
      queueName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName => deleteCWAlarm(alarmName, queueName))
    );
    log.info().msg('Status check alarm creation skipped due to tag settings.');
  } else {
    for (const config of metricConfigs) {
      const {metricName, namespace} = config;
      for (const classification of Object.values(AlarmClassification)) {
        const {alarmName, thresholdKey, durationTimeKey, durationPeriodsKey} =
          await getAlarmConfig(
            queueName,
            classification as AlarmClassification,
            metricName
          );

        const alarmProps: AlarmProps = {
          threshold: defaultThresholds[classification as AlarmClassification],
          period: 60,
          namespace: namespace,
          evaluationPeriods: 5,
          metricName: metricName,
          dimensions: [{Name: 'QueueName', Value: queueName}],
        };

        await createOrUpdateCWAlarm(
          alarmName,
          queueName,
          alarmProps,
          tags,
          thresholdKey,
          durationTimeKey,
          durationPeriodsKey
        );
      }
    }
  }
}

export async function manageSQSAlarms(
  queueUrl: string,
  tags: Tag
): Promise<void> {
  await checkAndManageSQSStatusAlarms(queueUrl, tags);
}

export async function manageInactiveSQSAlarms(queueUrl: string) {
  const queueName = extractQueueName(queueUrl);
  try {
    const activeAutoAlarms: string[] = await getCWAlarmsForInstance(
      'SQS',
      queueName
    );
    await Promise.all(
      activeAutoAlarms.map(alarmName => deleteCWAlarm(alarmName, queueName))
    );
  } catch (e) {
    log.error().err(e).msg(`Error deleting SQS alarms: ${e}`);
    throw new Error(`Error deleting SQS alarms: ${e}`);
  }
}

export async function getSqsEvent(
  event: any
): Promise<{queueUrl: string; eventName: ValidSqsEvent; tags: Tag}> {
  const queueUrl = event.detail.responseElements.queueUrl;
  const eventName = event.detail.eventName as ValidSqsEvent;
  log
    .info()
    .str('queueUrl', queueUrl)
    .str('eventName', eventName)
    .msg('Processing SQS event');

  const tags = await fetchSQSTags(queueUrl);

  if (queueUrl && eventName === ValidSqsEvent.CreateQueue) {
    await manageSQSAlarms(queueUrl, tags);
  } else if (eventName === ValidSqsEvent.DeleteQueue) {
    await manageInactiveSQSAlarms(queueUrl);
  }

  return {queueUrl, eventName, tags};
}
