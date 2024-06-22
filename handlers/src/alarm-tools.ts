import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
  PutMetricAlarmCommand,
} from '@aws-sdk/client-cloudwatch';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag} from './types';
import * as https from 'https';

const log = logging.getRootLogger();
const cloudWatchClient = new CloudWatchClient({});

export async function doesAlarmExist(alarmName: string): Promise<boolean> {
  const response = await cloudWatchClient.send(
    new DescribeAlarmsCommand({AlarmNames: [alarmName]})
  );
  return (response.MetricAlarms?.length ?? 0) > 0;
}

export async function needsUpdate(
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

export function configureAlarmPropsFromTags(
  alarmProps: AlarmProps,
  tags: Tag,
  thresholdKey: string,
  durationTimeKey: string,
  durationPeriodsKey: string
): void {
  // Adjust threshold based on tags or use default if not present as defined in alarm props
  if (!tags[thresholdKey]) {
    log.info().msg('Threshold tag not found, using default');
  } else if (tags[thresholdKey]) {
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
    // Adjust period based on tags or use default if not present as defined in alarm props
    if (!tags[durationTimeKey]) {
      log.info().msg('Period tag not found, using default');
    } else if (tags[durationTimeKey]) {
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
    }
    // Adjust evaluation periods based on tags or use default if not present as defined in alarm props
    if (!tags[durationPeriodsKey]) {
      log.info().msg('Evaluation periods tag not found, using default');
    } else if (tags[durationPeriodsKey]) {
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
    }
  }
}

export async function createOrUpdateAlarm(
  alarmName: string,
  instanceId: string,
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
      .str('instanceId', instanceId)
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
  if (!alarmExists || (alarmExists && (await needsUpdate(alarmName, props)))) {
    try {
      await cloudWatchClient.send(
        new PutMetricAlarmCommand({
          AlarmName: alarmName,
          ComparisonOperator: 'GreaterThanThreshold',
          EvaluationPeriods: props.evaluationPeriods,
          MetricName: props.metricName,
          Namespace: props.namespace,
          Period: props.period,
          Statistic: 'Average',
          Threshold: props.threshold,
          ActionsEnabled: false,
          Dimensions: props.dimensions,
        })
      );
      log
        .info()
        .str('alarmName', alarmName)
        .str('instanceId', instanceId)
        .num('threshold', props.threshold)
        .num('period', props.period)
        .num('evaluationPeriods', props.evaluationPeriods)
        .msg(`${alarmName} Alarm configured or updated.`);
    } catch (e) {
      log
        .error()
        .err(e)
        .str('alarmName', alarmName)
        .str('instanceId', instanceId)
        .msg(
          `Failed to create or update ${alarmName} alarm due to an error ${e}`
        );
    }
  }
}

// This function is used to grab all active auto alarms for a given instance and then pushes those to the activeAutoAlarms array
// which it returns to be used when the deleteAlarm function is called from within service module files.
// service identifier should be lowercase e.g. ec2, ecs, eks, rds, etc.
// instance identifier should be the identifier that is use for cloudwatch to pull alarm information. When add a new service
// list it here below:
// ec2: instanceID
// ecs: ...
// eks: ...
// rds: ...
export async function getAlarmsForInstance(
  serviceIdentifier: string,
  instanceIdentifier: string
): Promise<string[]> {
  const activeAutoAlarms: string[] = [];
  try {
    const describeAlarmsCommand = new DescribeAlarmsCommand({});
    const describeAlarmsResponse = await cloudWatchClient.send(
      describeAlarmsCommand
    );
    const alarms = describeAlarmsResponse.MetricAlarms || [];

    // Filter alarms by name prefix
    const instanceAlarms = alarms.filter(
      alarm =>
        alarm.AlarmName &&
        alarm.AlarmName.startsWith(
          `AutoAlarm-${serviceIdentifier}-${instanceIdentifier}`
        )
    );

    // Push the alarm names to activeAutoAlarmAlarms, ensuring AlarmName is defined
    activeAutoAlarms.push(
      ...instanceAlarms
        .map(alarm => alarm.AlarmName)
        .filter((alarmName): alarmName is string => !!alarmName)
    );

    log
      .info()
      .str(`${serviceIdentifier}`, instanceIdentifier)
      .str('alarms', JSON.stringify(instanceAlarms))
      .msg('Fetched alarms for instance');

    return activeAutoAlarms;
  } catch (error) {
    log
      .error()
      .err(error)
      .str(`${serviceIdentifier}`, instanceIdentifier)
      .msg('Failed to fetch alarms for instance');
    return [];
  }
}

export async function deleteAlarm(
  alarmName: string,
  instanceIdentifier: string
): Promise<void> {
  const alarmExists = await doesAlarmExist(alarmName);
  if (alarmExists) {
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceIdentifier)
      .msg('Attempting to delete alarm');
    await cloudWatchClient.send(
      new DeleteAlarmsCommand({AlarmNames: [alarmName]})
    );
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceIdentifier)
      .msg('Deleted alarm');
  } else {
    log
      .info()
      .str('alarmName', alarmName)
      .str('instanceId', instanceIdentifier)
      .msg('Alarm does not exist for instance');
  }
}

/*this function uses case switching to dynamically check that aws managed prometheus is receiving data from a service.
 * cases are ec2, ecs, eks, rds, ect <--- add more cases as needed and make note here in this comment. All Lower case.
 * ec2 service identifier is the instance private IP address.
 * ecs service identifier is...
 * eks service identifier is...
 * rds service identifier is...
 *QueryMetrics API documentation can be found here: https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-APIReference-QueryMetrics.html
 */

export async function queryPrometheusForService(
  serviceType: string,
  serviceIdentifier: string,
  promWorkspaceID: string,
  region: string
): Promise<boolean> {
  // Construct the Prometheus query URL path
  const queryPath = `/workspaces/${promWorkspaceID}/api/v1/query?query=`;

  // Create a promise to wrap the HTTPS request
  const makeRequest = (path: string): Promise<any> => {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: `aps-workspaces.${region}.amazonaws.com`,
        path: path,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          resolve(JSON.parse(data));
        });
      });

      req.on('error', error => {
        reject(error);
      });

      req.end();
    });
  };

  try {
    // Dynamically create the query based on service type
    let query = '';
    switch (serviceType) {
      case 'ec2': {
        log
          .info()
          .str('serviceType', serviceType)
          .str('serviceIdentifier', serviceIdentifier)
          .msg('Querying Prometheus for EC2 instances');
        query = 'up{job="ec2"}';
        // Make the HTTPS request to the Prometheus query endpoint
        const response = await makeRequest(
          queryPath + encodeURIComponent(query)
        );
        log
          .info()
          .str('serviceType', serviceType)
          .str('serviceIdentifier', serviceIdentifier)
          .str('Prometheus Workspace ID', promWorkspaceID)
          .str('response', JSON.stringify(response))
          .msg('Prometheus query successful');
        if (response.status !== 'success') {
          log
            .warn()
            .str('serviceType', serviceType)
            .str('serviceIdentifier', serviceIdentifier)
            .str('Prometheus Workspace ID', promWorkspaceID)
            .msg(
              'Prometheus query failed. Defaulting to CW Alarms if possible...'
            );
          return false;
        }
        // Extract IP addresses from the Prometheus response
        const ipAddresses = response.data.result.map((item: any) => {
          const instance = item.metric.instance;
          const ipAddr = instance.split(':')[0]; // Strip out the port
          return ipAddr;
        });
        log
          .info()
          .str('serviceType', serviceType)
          .str('serviceIdentifier', serviceIdentifier)
          .str('Prometheus Workspace ID', promWorkspaceID)
          .str('ipAddresses', JSON.stringify(ipAddresses))
          .msg('IP addresses extracted from Prometheus response.');
        // Check if the service identifier matches any of the IP addresses
        return ipAddresses.includes(serviceIdentifier);
      }
      // Add more cases here for other service types
      default: {
        log
          .warn()
          .str('serviceType', serviceType)
          .msg('Unsupported service type. Defaulting to CW Alarms if possible');
        return false;
      }
    }
  } catch (error) {
    log.error().err(error).msg('Error querying Prometheus:');
    return false;
  }
}

/* TODO:  as well as check if our promethuesWorkspaceId is not empty. Also check if namespace has 1k or more rules. If
    it does, create an incremented name space (e.g. AutoAlarm-EC2) with a for loop and add the rules to the new namespace.
 */

// Check if the Prometheus tag is set to true and if metrics are being sent to Prometheus
export async function isPromEnabled(
  instanceId: string,
  serviceType: string,
  serviceIdentifier: string,
  promWorkspaceId: string,
  region: string,
  tags: {[key: string]: string}
): Promise<boolean> {
  try {
    if (tags['Prometheus'] && tags['Prometheus'] === 'true') {
      log
        .info()
        .str('instanceId', instanceId)
        .msg(
          'Prometheus tag found. Checking if metrics are being sent to Prometheus'
        );
      const useProm = await queryPrometheusForService(
        serviceType,
        serviceIdentifier,
        promWorkspaceId,
        region
      );
      log
        .info()
        .str('instanceId', instanceId)
        .msg(`Prometheus metrics enabled=${useProm}`);
      return true; //this will be used for the useProm variable once we finish testing the inital logic
    } else if (
      (tags['Prometheus'] && tags['Prometheus'] === 'false') ||
      !tags['Prometheus'] ||
      (tags['Prometheus'] !== 'true' && tags['Prometheus'] !== 'false')
    ) {
      log
        .info()
        .str('instanceId', instanceId)
        .str('tags', JSON.stringify(tags))
        .msg('Prometheus tag not found or not set to true');
      return false;
    } else {
      return false;
    }
  } catch (error) {
    log
      .error()
      .err(error)
      .str('instanceId', instanceId)
      .msg('Failed to check Prometheus tag');
    throw new Error(
      `Failed to check Prometheus tag for instance ${instanceId}: ${error}`
    );
  }
}
