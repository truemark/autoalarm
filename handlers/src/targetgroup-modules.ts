import {
  DescribeAlarmsCommand,
  PutMetricAlarmCommand,
  DeleteAlarmsCommand,
  CloudWatchClient,
} from '@aws-sdk/client-cloudwatch';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types';
import {AlarmClassification} from './enums';

const log: logging.Logger = logging.getRootLogger();
const cloudWatchClient: CloudWatchClient = new CloudWatchClient({});

const defaultThresholds: {[key in AlarmClassification]: number} = {
  [AlarmClassification.Critical]: 15000,
  [AlarmClassification.Warning]: 10000,
};

const metricConfigs = [
  {metricName: 'TargetResponseTime', namespace: 'AWS/ApplicationELB'},
  {metricName: 'HTTPCode_Target_4XX_Count', namespace: 'AWS/ApplicationELB'},
  {metricName: 'HTTPCode_Target_5XX_Count', namespace: 'AWS/ApplicationELB'},
];

async function getAlarmConfig(
  targetGroupName: string,
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
    alarmName: `AutoAlarm-TargetGroup-${targetGroupName}-${type}-${metricName}`,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey,
  };
}

export async function manageTargetGroupAlarms(
  targetGroupName: string,
  tags: Tag,
  type: AlarmClassification
): Promise<void> {
  for (const config of metricConfigs) {
    const {metricName, namespace} = config;
    const {alarmName, thresholdKey, durationTimeKey, durationPeriodsKey} =
      await getAlarmConfig(targetGroupName, type, metricName);

    const alarmProps: AlarmProps = {
      threshold: defaultThresholds[type],
      period: 60,
      namespace: namespace,
      evaluationPeriods: 5,
      metricName: metricName,
      dimensions: [{Name: 'TargetGroup', Value: targetGroupName}],
    };

    await createOrUpdateCWAlarm(
      alarmName,
      targetGroupName,
      alarmProps,
      tags,
      thresholdKey,
      durationTimeKey,
      durationPeriodsKey
    );
  }
}

async function doesAlarmExist(alarmName: string): Promise<boolean> {
  const response = await cloudWatchClient.send(
    new DescribeAlarmsCommand({AlarmNames: [alarmName]})
  );
  return (response.MetricAlarms?.length ?? 0) > 0;
}

async function CWAlarmNeedsUpdate(
  alarmName: string,
  newProps: AlarmProps
): Promise<boolean> {
  try {
    const existingAlarm = await cloudWatchClient.send(
      new DescribeAlarmsCommand({AlarmNames: [alarmName]})
    );

    if (existingAlarm.MetricAlarms && existingAlarm.MetricAlarms.length > 0) {
      const existingProps = existingAlarm.MetricAlarms[0];

      if (
        Number(existingProps.Threshold) !== newProps.threshold ||
        Number(existingProps.EvaluationPeriods) !==
          newProps.evaluationPeriods ||
        Number(existingProps.Period) !== newProps.period
      ) {
        log.info().str('alarmName', alarmName).msg('Alarm needs update');
        return true;
      }
    } else {
      log.info().str('alarmName', alarmName).msg('Alarm does not exist');
      return true;
    }

    log.info().str('alarmName', alarmName).msg('Alarm does not need update');
    return false;
  } catch (e) {
    log.error().err(e).msg('Failed to determine if alarm needs update:');
    return false;
  }
}

function configureAlarmPropsFromTags(
  alarmProps: AlarmProps,
  tags: Tag,
  thresholdKey: string,
  durationTimeKey: string,
  durationPeriodsKey: string
): void {
  // Adjust threshold based on tags or use default if not present as defined in alarm props
  if (tags[thresholdKey]) {
    const parsedThreshold = parseFloat(tags[thresholdKey]);
    if (!isNaN(parsedThreshold)) {
      alarmProps.threshold = parsedThreshold;
      log
        .info()
        .str('tag', thresholdKey)
        .num('threshold', parsedThreshold)
        .msg('Adjusted threshold based on tag');
    } else {
      log
        .warn()
        .str('tag', thresholdKey)
        .str('value', tags[thresholdKey])
        .msg('Invalid threshold value in tag, using default');
    }
  } else {
    log.info().msg('Threshold tag not found, using default');
  }

  // Adjust period based on tags or use default if not present as defined in alarm props
  if (tags[durationTimeKey]) {
    let parsedPeriod = parseInt(tags[durationTimeKey], 10);
    if (!isNaN(parsedPeriod)) {
      if (parsedPeriod < 10) {
        parsedPeriod = 10;
        log
          .info()
          .str('tag', durationTimeKey)
          .num('period', parsedPeriod)
          .msg(
            'Period value less than 10 is not allowed, must be 10. Using default value of 10'
          );
      } else if (parsedPeriod < 30) {
        parsedPeriod = 30;
        log
          .info()
          .str('tag', durationTimeKey)
          .num('period', parsedPeriod)
          .msg(
            'Period value less than 30 and not 10 is adjusted to 30. Using default value of 30'
          );
      } else {
        parsedPeriod = Math.ceil(parsedPeriod / 60) * 60;
        log
          .info()
          .str('tag', durationTimeKey)
          .num('period', parsedPeriod)
          .msg(
            'Period value not 10 or 30 must be multiple of 60. Adjusted to nearest multiple of 60'
          );
      }
      alarmProps.period = parsedPeriod;
    } else {
      log
        .warn()
        .str('tag', durationTimeKey)
        .str('value', tags[durationTimeKey])
        .msg('Invalid period value in tag, using default 60 seconds');
    }
  } else {
    log.info().msg('Period tag not found, using default');
  }

  // Adjust evaluation periods based on tags or use default if not present as defined in alarm props
  if (tags[durationPeriodsKey]) {
    const parsedEvaluationPeriods = parseInt(tags[durationPeriodsKey], 10);
    if (!isNaN(parsedEvaluationPeriods)) {
      alarmProps.evaluationPeriods = parsedEvaluationPeriods;
      log
        .info()
        .str('tag', durationPeriodsKey)
        .num('evaluationPeriods', parsedEvaluationPeriods)
        .msg('Adjusted evaluation periods based on tag');
    } else {
      log
        .warn()
        .str('tag', durationPeriodsKey)
        .str('value', tags[durationPeriodsKey])
        .msg('Invalid evaluation periods value in tag, using default 5');
    }
  } else {
    log.info().msg('Evaluation periods tag not found, using default');
  }
}

async function createOrUpdateCWAlarm(
  alarmName: string,
  targetGroupName: string,
  props: AlarmProps,
  tags: Tag,
  thresholdKey: string,
  durationTimeKey: string,
  durationPeriodsKey: string
) {
  try {
    log
      .info()
      .str('alarmName', alarmName)
      .str('targetGroupName', targetGroupName)
      .msg('Configuring alarm props from tags');
    configureAlarmPropsFromTags(
      props,
      tags,
      thresholdKey,
      durationTimeKey,
      durationPeriodsKey
    );
  } catch (e) {
    log.error().err(e).msg('Error configuring alarm props from tags');
    throw new Error('Error configuring alarm props from tags');
  }
  const alarmExists = await doesAlarmExist(alarmName);
  if (
    !alarmExists ||
    (alarmExists && (await CWAlarmNeedsUpdate(alarmName, props)))
  ) {
    try {
      await cloudWatchClient.send(
        new PutMetricAlarmCommand({
          AlarmName: alarmName,
          ComparisonOperator: 'GreaterThanThreshold',
          EvaluationPeriods: props.evaluationPeriods,
          MetricName: props.metricName,
          Namespace: props.namespace,
          Period: props.period,
          Statistic: 'Sum',
          Threshold: props.threshold,
          ActionsEnabled: false,
          Dimensions: props.dimensions,
        })
      );
      log
        .info()
        .str('alarmName', alarmName)
        .str('targetGroupName', targetGroupName)
        .num('threshold', props.threshold)
        .num('period', props.period)
        .num('evaluationPeriods', props.evaluationPeriods)
        .msg(`${alarmName} Alarm configured or updated.`);
    } catch (e) {
      log
        .error()
        .err(e)
        .str('alarmName', alarmName)
        .str('targetGroupName', targetGroupName)
        .msg(
          `Failed to create or update ${alarmName} alarm due to an error ${e}`
        );
    }
  }
}

export async function deleteCWAlarm(
  alarmName: string,
  targetGroupName: string
): Promise<void> {
  const alarmExists = await doesAlarmExist(alarmName);
  if (alarmExists) {
    log
      .info()
      .str('alarmName', alarmName)
      .str('targetGroupName', targetGroupName)
      .msg('Attempting to delete alarm');
    await cloudWatchClient.send(
      new DeleteAlarmsCommand({AlarmNames: [alarmName]})
    );
    log
      .info()
      .str('alarmName', alarmName)
      .str('targetGroupName', targetGroupName)
      .msg('Deleted alarm');
  } else {
    log
      .info()
      .str('alarmName', alarmName)
      .str('targetGroupName', targetGroupName)
      .msg('Alarm does not exist for target group');
  }
}
