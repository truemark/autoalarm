import {
  CloudWatchClient,
  ComparisonOperator,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
  PutAnomalyDetectorCommand,
  PutMetricAlarmCommand,
  Statistic,
} from '@aws-sdk/client-cloudwatch';
import {
  AmpClient,
  ListRuleGroupsNamespacesCommand,
  DescribeRuleGroupsNamespaceCommand,
  CreateRuleGroupsNamespaceCommand,
  PutRuleGroupsNamespaceCommand,
  RuleGroupsNamespaceSummary,
  DeleteRuleGroupsNamespaceCommand,
  DescribeWorkspaceCommand,
  DescribeWorkspaceCommandInput,
} from '@aws-sdk/client-amp';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import * as yaml from 'js-yaml';
import * as aws4 from 'aws4';
import {defaultProvider} from '@aws-sdk/credential-provider-node';
import * as logging from '@nr1e/logging';
import {
  AlarmProps,
  RuleGroup,
  NamespaceDetails,
  Rule,
  AnomalyAlarmProps,
} from './types.mjs';
import * as https from 'https';
import {AlarmClassification} from './enums.mjs';

const region: string = process.env.AWS_REGION || '';
const retryStrategy = new ConfiguredRetryStrategy(20);
const log = logging.getLogger('alarm-tools');
const cloudWatchClient = new CloudWatchClient({
  region,
  retryStrategy: retryStrategy,
});
const client = new AmpClient({region, credentials: defaultProvider()}); //used for Prometheus

export async function doesAlarmExist(alarmName: string): Promise<boolean> {
  const response = await cloudWatchClient.send(
    new DescribeAlarmsCommand({AlarmNames: [alarmName]}),
  );
  log
    .info()
    .str('function', 'doesAlarmExist')
    .str('alarmName', alarmName)
    .str('response', JSON.stringify(response))
    .msg('Checking if alarm exists');
  return (response.MetricAlarms?.length ?? 0) > 0;
}

// returns true if the alarm needs to be updated whether it exists or does not. For Anomaly Detection CW alarms
export async function anomalyCWAlarmNeedsUpdate(
  alarmName: string,
  newProps: AnomalyAlarmProps,
): Promise<boolean> {
  try {
    const existingAlarm = await cloudWatchClient.send(
      new DescribeAlarmsCommand({AlarmNames: [alarmName]}),
    );

    if (existingAlarm.MetricAlarms && existingAlarm.MetricAlarms.length > 0) {
      const existingProps = existingAlarm.MetricAlarms[0];

      log
        .info()
        .str('function', 'anomalyCWAlarmNeedsUpdate')
        .str('alarmName', alarmName)
        .str('existingProps', JSON.stringify(existingProps))
        .str('newProps', JSON.stringify(newProps))
        .msg('Checking if anomaly detection alarm needs');

      if (
        existingProps.EvaluationPeriods !== newProps.evaluationPeriods ||
        existingProps.Period !== newProps.period ||
        existingProps.ExtendedStatistic !== newProps.extendedStatistic
      ) {
        log
          .info()
          .str('function', 'anomalyCWAlarmNeedsUpdate')
          .str('alarmName', alarmName)
          .str(
            'existingEvaluationPeriods',
            existingProps.EvaluationPeriods?.toString() || 'undefined',
          )
          .str(
            'newEvaluationPeriods',
            newProps.evaluationPeriods.toString() || 'undefined',
          )
          .str(
            'existingPeriod',
            existingProps.Period?.toString() || 'undefined',
          )
          .str('newPeriod', newProps.period.toString() || 'undefined')
          .str(
            'existingExtendedStatistic',
            existingProps.ExtendedStatistic || 'undefined',
          )
          .str('newExtendedStatistic', newProps.extendedStatistic)
          .msg('Anomaly Detection Alarm needs update');
        return true;
      }
    } else {
      log
        .info()
        .str('function', 'anomalyCWAlarmNeedsUpdate')
        .str('alarmName', alarmName)
        .msg('Anomaly Detection Alarm does not exist');
      return true;
    }

    log
      .info()
      .str('function', 'anomalyCWAlarmNeedsUpdate')
      .str('alarmName', alarmName)
      .msg('Anomaly Detection Alarm does not need update');
    return false;
  } catch (e) {
    log
      .error()
      .err(e)
      .str('function', 'anomalyCWAlarmNeedsUpdate')
      .msg('Failed to determine if anomaly detection alarm needs update:');
    throw new Error(
      'Failed to determine if anomaly detection alarm needs update.',
    );
  }
}

// returns true if the alarm needs to be updated whether it exists or does not. For Static threshold CW alarms
export async function staticCWAlarmNeedsUpdate(
  alarmName: string,
  newProps: AlarmProps,
): Promise<boolean> {
  try {
    const existingAlarm = await cloudWatchClient.send(
      new DescribeAlarmsCommand({AlarmNames: [alarmName]}),
    );

    if (existingAlarm.MetricAlarms && existingAlarm.MetricAlarms.length > 0) {
      const existingProps = existingAlarm.MetricAlarms[0];

      const existingStatistic =
        existingProps.Statistic || existingProps.ExtendedStatistic;
      const newStatistic = newProps.statistic || newProps.extendedStatistic;

      if (
        existingProps.Threshold !== newProps.threshold ||
        existingProps.EvaluationPeriods !== newProps.evaluationPeriods ||
        existingProps.Period !== newProps.period ||
        existingStatistic !== newStatistic
      ) {
        log
          .info()
          .str('alarmName', alarmName)
          .str(
            'existingThreshold',
            existingProps.Threshold?.toString() || 'undefined',
          )
          .str('newThreshold', newProps.threshold?.toString() || 'undefined')
          .str(
            'existingEvaluationPeriods',
            existingProps.EvaluationPeriods?.toString() || 'undefined',
          )
          .str(
            'newEvaluationPeriods',
            newProps.evaluationPeriods?.toString() || 'undefined',
          )
          .str(
            'existingPeriod',
            existingProps.Period?.toString() || 'undefined',
          )
          .str('newPeriod', newProps.period?.toString() || 'undefined')
          .str(
            'existingStatistic',
            existingStatistic?.toString() || 'undefined',
          )
          .str('newStatistic', newStatistic?.toString() || 'undefined')
          .msg('Alarm needs update');
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
  threshold: number,
  durationTime: number,
  durationPeriods: number,
  statistic?: Statistic,
  extendedStatistic?: string,
): void {
  alarmProps.threshold = threshold;
  log
    .info()
    .str('function', 'configureAlarmPropsFromTags')
    .num('threshold', threshold)
    .msg('Adjusted threshold based on tag');

  if (durationTime < 10) {
    durationTime = 10;
    log
      .info()
      .str('function', 'configureAlarmPropsFromTags')
      .num('period', durationTime)
      .msg(
        'Period value less than 10 is not allowed, must be 10. Using default value of 10',
      );
  } else if (durationTime < 30 || durationTime <= 45) {
    durationTime = 30;
    log
      .info()
      .str('function', 'configureAlarmPropsFromTags')
      .num('period', durationTime)
      .msg(
        'Period value is either 30, < 30, <= 45 or 30. Using default value of 30',
      );
  } else {
    durationTime = Math.ceil(durationTime / 60) * 60;
    log
      .info()
      .str('function', 'configureAlarmPropsFromTags')
      .num('period', durationTime)
      .msg(
        'Period value not 10 or 30 must be multiple of 60. Adjusted to nearest multiple of 60',
      );
  }
  alarmProps.period = durationTime;
  log
    .info()
    .str('function', 'configureAlarmPropsFromTags')
    .num('period', durationTime)
    .msg('Adjusted period based on tag');

  // Adjust evaluation periods based on tags or use default if not present as defined in alarm props

  alarmProps.evaluationPeriods = durationPeriods;
  log
    .info()
    .str('function', 'configureAlarmPropsFromTags')
    .num('evaluationPeriods', durationPeriods)
    .msg('Adjusted evaluation periods based on tag');

  if (statistic) {
    alarmProps.statistic = statistic;
    log
      .info()
      .str('function', 'configureAlarmPropsFromTags')
      .str('statistic', statistic)
      .msg('Adjusted statistic based on tag');
  }
  if (extendedStatistic) {
    alarmProps.extendedStatistic = extendedStatistic;
  }
}

export async function createOrUpdateAnomalyDetectionAlarm(
  alarmName: string,
  dimensionName: string,
  dimensionNameValue: string,
  metricName: string,
  namespace: string,
  extendedStatistic: string,
  durationTime: number,
  durationPeriods: number,
  classification: AlarmClassification,
) {
  if (durationTime < 10) {
    durationTime = 10;
    log
      .info()
      .str('function', 'createOrUpdateAnomalyDetectionAlarm')
      .num('period', durationTime)
      .msg(
        'Period value less than 10 is not allowed, must be 10. Using default value of 10',
      );
  } else if (durationTime < 30 || durationTime <= 45) {
    durationTime = 30;
    log
      .info()
      .str('function', 'createOrUpdateAnomalyDetectionAlarm')
      .num('period', durationTime)
      .msg(
        'Period value is either 30, < 30, <= 45 or 30. Using default value of 30',
      );
  } else {
    durationTime = Math.ceil(durationTime / 60) * 60;
    log
      .info()
      .str('function', 'createOrUpdateAnomalyDetectionAlarm')
      .num('period', durationTime)
      .msg(
        'Period value not 10 or 30 must be multiple of 60. Adjusted to nearest multiple of 60',
      );
  }
  const newProps: AnomalyAlarmProps = {
    evaluationPeriods: durationPeriods,
    period: durationTime,
    extendedStatistic: extendedStatistic,
  };
  const alarmExists = await doesAlarmExist(alarmName);
  if (
    !alarmExists ||
    (alarmExists && (await anomalyCWAlarmNeedsUpdate(alarmName, newProps)))
  ) {
    try {
      // Create anomaly detector with the latest parameters
      const anomalyDetectorInput = {
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: [
          {
            Name: dimensionName,
            Value: dimensionNameValue,
          },
        ],
        Stat: extendedStatistic,
        Configuration: {
          MetricTimezone: 'UTC',
        },
      };
      log
        .debug()
        .obj('input', anomalyDetectorInput)
        .msg('Sending PutAnomalyDetectorCommand');
      await cloudWatchClient.send(
        new PutAnomalyDetectorCommand(anomalyDetectorInput),
      );

      // Create anomaly detection alarm
      const metricAlarmInput = {
        AlarmName: alarmName,
        ComparisonOperator: ComparisonOperator.GreaterThanUpperThreshold,
        EvaluationPeriods: durationPeriods,
        Metrics: [
          {
            Id: 'primaryMetric',
            MetricStat: {
              Metric: {
                Namespace: namespace,
                MetricName: metricName,
                Dimensions: [{Name: dimensionName, Value: dimensionNameValue}],
              },
              Period: durationTime,
              Stat: extendedStatistic,
            },
          },
          {
            Id: 'anomalyDetectionBand',
            Expression: 'ANOMALY_DETECTION_BAND(primaryMetric)',
          },
        ],
        ThresholdMetricId: 'anomalyDetectionBand',
        ActionsEnabled: false,
        Tags: [{Key: 'severity', Value: classification}],
        TreatMissingData: 'ignore', // Adjust as needed
      };
      await cloudWatchClient.send(new PutMetricAlarmCommand(metricAlarmInput));

      log
        .info()
        .str('function', 'createOrUpdateAnomalyDetectionAlarm')
        .str('alarmName', alarmName)
        .str('serviceIdentifier', dimensionNameValue)
        .msg(`${alarmName} Anomaly Detection Alarm created or updated.`);
    } catch (e) {
      log
        .error()
        .str('function', 'createOrUpdateAnomalyDetectionAlarm')
        .err(e)
        .str('alarmName', alarmName)
        .str('serviceIdentifier', dimensionNameValue)
        .msg(
          `Failed to create or update ${alarmName} anomaly detection alarm due to an error ${e}`,
        );
    }
  }
}

// Define the possible values for MissingDataTreatment
export type MissingDataTreatment = 'breaching' | 'notBreaching' | 'ignore';

// Define the possible values for Statistic
//type Statistic = 'Average' | 'Sum' | 'Minimum' | 'Maximum';

// This function is used to create or update a CW alarm based on the provided values.
export async function createOrUpdateCWAlarm(
  alarmName: string,
  serviceIdentifier: string,
  props: AlarmProps,
  threshold: number,
  durationTime: number,
  durationPeriods: number,
  severityType: string,
  missingDataTreatment: MissingDataTreatment = 'ignore', // Default to 'ignore' if not specified
  statistic?: Statistic | undefined,
  extendedStatistic?: string | undefined,
) {
  try {
    log
      .info()
      .str('function', 'createOrUpdateCWAlarm')
      .str('alarmName', alarmName)
      .str('Service Identifier', serviceIdentifier)
      .num('threshold', threshold)
      .num('period', durationTime)
      .num('evaluationPeriods', durationPeriods)
      .msg('Configuring alarm props from provided values');

    configureAlarmPropsFromTags(
      props,
      threshold,
      durationTime,
      durationPeriods,
      statistic,
      extendedStatistic,
    );

    log
      .info()
      .str('function', 'createOrUpdateCWAlarm')
      .str('alarmName', alarmName)
      .str('Service Identifier', serviceIdentifier)
      .num('threshold', props.threshold)
      .num('period', props.period)
      .num('evaluationPeriods', props.evaluationPeriods)
      .msg('Alarm props configured from provided values');
  } catch (e) {
    log
      .error()
      .str('function', 'createOrUpdateCWAlarm')
      .err(e)
      .msg('Error configuring alarm props from provided values');
    throw new Error('Error configuring alarm props from provided values');
  }

  const alarmExists = await doesAlarmExist(alarmName);
  if (
    !alarmExists ||
    (alarmExists && (await staticCWAlarmNeedsUpdate(alarmName, props)))
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
          ...(statistic
            ? {Statistic: statistic}
            : {ExtendedStatistic: extendedStatistic}),
          Threshold: props.threshold,
          ActionsEnabled: false,
          Dimensions: props.dimensions,
          Tags: [{Key: 'severity', Value: severityType.toLowerCase()}],
          TreatMissingData: missingDataTreatment,
        }),
      );
      log
        .info()
        .str('function', 'createOrUpdateCWAlarm')
        .str('alarmName', alarmName)
        .str('serviceIdentifier', serviceIdentifier)
        .num('threshold', props.threshold)
        .num('period', props.period)
        .num('evaluationPeriods', props.evaluationPeriods)
        .msg(`${alarmName} Alarm configured or updated.`);
    } catch (e) {
      log
        .error()
        .str('function', 'createOrUpdateCWAlarm')
        .err(e)
        .str('alarmName', alarmName)
        .str('instanceId', serviceIdentifier)
        .msg(
          `Failed to create or update ${alarmName} alarm due to an error ${e}`,
        );
    }
  }
}

// This function is used to grab all active CW auto alarms for a given instance and then pushes those to the activeAutoAlarms array
// which it returns to be used when the deleteCWAlarm function is called from within service module files.
// service identifier should be lowercase e.g. ec2, ecs, eks, rds, etc.
// serviceIdentifier should be all UPPER CASE
// instance identifier should be the identifier that is use for cloudwatch to pull alarm information. When adding a new service
// list it here below:
// EC2: instanceID
// ECS: ...
// EKS: ...
// RDS: ...
export async function getCWAlarmsForInstance(
  serviceIdentifier: string,
  instanceIdentifier: string,
): Promise<string[]> {
  const activeAutoAlarms: string[] = [];
  try {
    const describeAlarmsCommand = new DescribeAlarmsCommand({});
    const describeAlarmsResponse = await cloudWatchClient.send(
      describeAlarmsCommand,
    );
    const alarms = describeAlarmsResponse.MetricAlarms || [];

    // Filter alarms by name prefix
    log
      .info()
      .str('function', 'getCWAlarmsForInstance')
      .str('serviceIdentifier', serviceIdentifier)
      .str('instanceIdentifier', instanceIdentifier)
      .str(
        'alarm prefix',
        `AutoAlarm-${serviceIdentifier}-${instanceIdentifier}`,
      )
      .msg('Filtering alarms by name');
    const instanceAlarms = alarms.filter(
      (alarm) =>
        alarm.AlarmName &&
        (alarm.AlarmName.startsWith(
          `AutoAlarm-${serviceIdentifier}-${instanceIdentifier}`,
        ) ||
          alarm.AlarmName.startsWith(
            `AutoAlarm-${serviceIdentifier}-${instanceIdentifier}-Anomaly`,
          ) ||
          alarm.AlarmName.startsWith(
            `AutoAlarm-${serviceIdentifier}-${instanceIdentifier}`,
          )),
    );

    // Push the alarm names to activeAutoAlarmAlarms, ensuring AlarmName is defined
    activeAutoAlarms.push(
      ...instanceAlarms
        .map((alarm) => alarm.AlarmName)
        .filter((alarmName): alarmName is string => !!alarmName),
    );

    log
      .info()
      .str('function', 'getCWAlarmsForInstance')
      .str(`${serviceIdentifier}`, instanceIdentifier)
      .str('alarms', JSON.stringify(instanceAlarms))
      .msg('Fetched alarms for instance');

    return activeAutoAlarms;
  } catch (error) {
    log
      .error()
      .str('function', 'getCWAlarmsForInstance')
      .err(error)
      .str(`${serviceIdentifier}`, instanceIdentifier)
      .msg('Failed to fetch alarms for instance');
    return [];
  }
}

export async function deleteCWAlarm(
  alarmName: string,
  instanceIdentifier: string,
): Promise<void> {
  log
    .info()
    .str('function', 'deleteCWAlarm')
    .str('alarmName', alarmName)
    .msg('checking if alarm exists...');
  const alarmExists = await doesAlarmExist(alarmName);
  if (alarmExists) {
    log
      .info()
      .str('function', 'deleteCWAlarm')
      .str('alarmName', alarmName)
      .str('instanceId', instanceIdentifier)
      .msg('Attempting to delete alarm');
    await cloudWatchClient.send(
      new DeleteAlarmsCommand({AlarmNames: [alarmName]}),
    );
    log
      .info()
      .str('function', 'deleteCWAlarm')
      .str('alarmName', alarmName)
      .str('instanceId', instanceIdentifier)
      .msg('Deleted alarm');
  } else {
    log
      .info()
      .str('function', 'deleteCWAlarm')
      .str('alarmName', alarmName)
      .str('instanceId', instanceIdentifier)
      .msg('Alarm does not exist for instance');
  }
}

/*
 * All Fucntions Below this point are used to interact with Promehteus and check
 */

// We use the following const to make a signed http request for the prom APIs following patterns found in this example:
// https://github.com/aws-samples/sigv4-signing-examples/blob/main/sdk/nodejs/main.js. We use defaultProvider to get the
// credentials needed to sign the request. We then sign the request using aws4 and make the request using https.request.
const makeSignedRequest = async (
  path: string,
  region: string,
  // TODO Fix the use of any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> => {
  const hostname = `aps-workspaces.${region}.amazonaws.com`;

  // Fetch credentials using the default provider
  const credentials = await defaultProvider()();

  // Define the request options
  const options = {
    hostname,
    path,
    method: 'GET',
    headers: {
      'host': hostname,
      'Content-Type': 'application/json',
    },
  };

  // Sign the request using aws4
  const signer = aws4.sign(
    {
      service: 'aps',
      region: region,
      path: path,
      headers: options.headers,
      method: options.method,
      body: '',
    },
    {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  );

  // Add signed headers to the request options
  Object.assign(options.headers, signer.headers);

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        log
          .info()
          .str('function', 'makeSignedRequest')
          .num('statusCode', res.statusCode || 0)
          .msg('Response received');

        try {
          const parsedData = JSON.parse(data);
          log
            .info()
            .str('function', 'makeSignedRequest')
            .num('statusCode', res.statusCode || 0)
            .str('parsedData', JSON.stringify(parsedData, null, 2))
            .msg('Parsed response data');
          resolve(parsedData);
        } catch (error) {
          log
            .error()
            .str('function', 'makeSignedRequest')
            .num('statusCode', res.statusCode || 0)
            .err(error)
            .str('rawData', data)
            .msg('Failed to parse response data');
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      log
        .error()
        .str('function', 'makeSignedRequest')
        .err(error)
        .msg('Request error');
      reject(error);
    });

    req.end();
  });
};

/* this function uses case switching to dynamically check that aws managed prometheus is receiving data from a service.
 * cases are ec2, ecs, eks, rds, etc <--- add more cases as needed and make note here in this comment. All Lower case.
 * ec2 service identifier is the instance private IP address.
 * ecs service identifier is...
 * eks service identifier is...
 * rds service identifier is...
 * QueryMetrics API documentation can be found here: https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-APIReference-QueryMetrics.html
 */

/**
 * Function to query Prometheus for services.
 * @param serviceType - The type of service (e.g., 'ec2').
 * @param promWorkspaceID - The Prometheus workspace ID.
 * @param region - The AWS region.
 * @returns Promise resolving to Prometheus query result.
 */
export async function queryPrometheusForService(
  serviceType: string,
  promWorkspaceID: string,
  region: string,
): Promise<string[]> {
  const queryPath = `/workspaces/${promWorkspaceID}/api/v1/query?query=`;

  try {
    let query = '';
    switch (serviceType) {
      case 'ec2': {
        // Log the initial function call details
        log
          .info()
          .str('function', 'queryPrometheusForService')
          .str('serviceType', serviceType)
          .str('promWorkspaceID', promWorkspaceID)
          .str('region', region)
          .msg('Querying Prometheus for EC2 instances');

        // TODO: DevOps to potentially add job label back but we may need to use go_info for the query
        // query = 'up{job="ec2"}';
        // Define the query to use go_info metric
        query = 'go_info';
        const response = await makeSignedRequest(
          queryPath + encodeURIComponent(query),
          region,
        );

        // Log the raw Prometheus query result
        log
          .info()
          .str('function', 'queryPrometheusForService')
          .str('serviceType', serviceType)
          .str('Prometheus Workspace ID', promWorkspaceID)
          .str('region', region)
          .str('response', JSON.stringify(response, null, 2))
          .msg('Raw Prometheus query result');

        // Check for a successful response structure
        if (
          !response ||
          response.status !== 'success' ||
          !response.data ||
          !response.data.result
        ) {
          // Log a warning if the query failed or returned an unexpected structure
          log
            .warn()
            .str('function', 'queryPrometheusForService')
            .str('serviceType', serviceType)
            .str('Prometheus Workspace ID', promWorkspaceID)
            .str('response', JSON.stringify(response, null, 2))
            .msg('Prometheus query failed or returned unexpected structure.');
          return [];
        }

        const instances = new Set<string>();

        // Regex for matching IP address:port
        const ipPortRegex = /(\d{1,3}\.){3}\d{1,3}:\d+$/;
        // Regex for matching AWS EC2 instance ID
        const ec2InstanceIdRegex = /^i-[a-zA-Z0-9]+$/;

        // Extract unique instances private IPs or instance IDs from query results
        // TODO Fix the use of any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response.data.result.forEach((item: any) => {
          const instance = item.metric.instance;

          // Log the instance being processed
          log
            .info()
            .str('function', 'queryPrometheusForService')
            .str('instance', instance)
            .msg('Processing instance from Prometheus response');

          if (ipPortRegex.test(instance)) {
            const ip = instance.split(':')[0];
            instances.add(ip);
            // Log the matched IP address
            log
              .info()
              .str('function', 'queryPrometheusForService')
              .str('ip', ip)
              .msg('Matched IP address');
          } else if (ec2InstanceIdRegex.test(instance)) {
            instances.add(instance);
            // Log the matched EC2 instance ID
            log
              .info()
              .str('function', 'queryPrometheusForService')
              .str('instanceId', instance)
              .msg('Matched EC2 instance ID');
          } else {
            // Log a warning if the instance did not match any regex patterns
            log
              .warn()
              .str('function', 'queryPrometheusForService')
              .str('instance', instance)
              .msg('Instance did not match any regex patterns');
          }
        });

        // Log the unique instances extracted from the Prometheus response
        log
          .info()
          .str('function', 'queryPrometheusForService')
          .str('serviceType', serviceType)
          .str('Prometheus Workspace ID', promWorkspaceID)
          .msg('Unique instances extracted from Prometheus response');

        return Array.from(instances);
      }
      default: {
        // Log a warning if an unsupported service type is provided
        log
          .warn()
          .str('function', 'queryPrometheusForService')
          .str('serviceType', serviceType)
          .msg('Unsupported service type.');
        return [];
      }
    }
  } catch (error) {
    // Log an error if there was an issue querying Prometheus
    log
      .error()
      .err(error)
      .str('function', 'queryPrometheusForService')
      .str('serviceType', serviceType)
      .str('Prometheus Workspace ID', promWorkspaceID)
      .str('region', region)
      .msg('Error querying Prometheus');
    return [];
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Function to list namespaces
const listNamespaces = async (
  workspaceId: string,
): Promise<RuleGroupsNamespaceSummary[]> => {
  const command = new ListRuleGroupsNamespacesCommand({workspaceId});
  log.info().str('workspaceId', workspaceId).msg('Listing namespaces');
  try {
    const response = await client.send(command);
    log
      .info()
      .str('response', JSON.stringify(response))
      .msg('Successfully listed namespaces');
    return response.ruleGroupsNamespaces ?? [];
  } catch (error) {
    log.error().err(error).msg('Error listing namespaces');
    await wait(60000); // Wait for 60 seconds before retrying
    return listNamespaces(workspaceId);
  }
};

// Function to describe a namespace
export const describeNamespace = async (
  workspaceId: string,
  namespace: string,
): Promise<NamespaceDetails | null> => {
  const command = new DescribeRuleGroupsNamespaceCommand({
    workspaceId,
    name: namespace,
  });
  log
    .info()
    .str('function', 'describeNamespace')
    .str('workspaceId', workspaceId)
    .str('namespace', namespace)
    .msg('Describing namespace');

  try {
    const response = await client.send(command);
    if (response.ruleGroupsNamespace) {
      const dataStr = new TextDecoder().decode(
        response.ruleGroupsNamespace.data,
      );
      log
        .info()
        .str('function', 'describeNamespace')
        .str('rawData', dataStr)
        .msg('Raw data from API');
      try {
        const nsDetails = yaml.load(dataStr) as NamespaceDetails;
        if (!isNamespaceDetails(nsDetails)) {
          throw new Error('Invalid namespace details structure');
        }
        log
          .info()
          .str('function', 'describeNamespace')
          .str('namespace', namespace)
          .str('details', JSON.stringify(nsDetails))
          .msg('Namespace described');
        return nsDetails;
      } catch (parseError) {
        log
          .error()
          .str('function', 'describeNamespace')
          .err(parseError)
          .str('rawData', dataStr)
          .msg('Failed to parse namespace data');
        throw parseError;
      }
    }
    log
      .warn()
      .str('function', 'describeNamespace')
      .str('namespace', namespace)
      .msg('No data returned for namespace');
    return null;
  } catch (error) {
    log
      .error()
      .str('function', 'describeNamespace')
      .err(error)
      .msg('Error describing namespace');
    return null; // Ensure that the function always returns a value
  }
};

// Function to create a new namespace
async function createNamespace(
  promWorkspaceId: string,
  namespace: string,
  // TODO Fix the use of any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  alarmConfigs: any[],
) {
  log
    .info()
    .str('function', 'createNamespace')
    .str('promWorkspaceId', promWorkspaceId)
    .str('namespace', namespace)
    .msg('Creating new Prometheus namespace with rules');

  const nsDetails = {
    groups: [
      {
        name: 'AutoAlarm',
        rules: alarmConfigs.map((config) => ({
          alert: config.alarmName,
          expr: config.alarmQuery,
          for: config.duration,
          labels: {severity: config.severityType},
          annotations: {
            summary: `${config.alarmName} alert triggered`,
            description: 'The alert was triggered based on the specified query',
          },
        })),
      },
    ],
  };

  const updatedYaml = yaml.dump(nsDetails);
  const updatedData = new TextEncoder().encode(updatedYaml);

  const input = {
    workspaceId: promWorkspaceId,
    name: namespace,
    data: updatedData,
  };

  try {
    const command = new CreateRuleGroupsNamespaceCommand(input);
    await client.send(command);
  } catch (error) {
    log
      .error()
      .str('function', 'createNamespace')
      .err(error)
      .msg('Failed to create namespace');
  }

  log
    .info()
    .str('function', 'createNamespace')
    .str('namespace', namespace)
    .msg('Created new namespace and added rules');
}

// Helper function to ensure that the object is a NamespaceDetails interface
function isNamespaceDetails(obj: unknown): obj is NamespaceDetails {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'groups' in obj &&
    Array.isArray((obj as NamespaceDetails).groups)
  );
}

// This function is used to verify that a workspace exists and is active.
async function verifyPromWorkspace(promWorkspaceId: string) {
  // we have to cast our promWorkspaceId to the DescribeWorkspaceCommandInput type in order to query for the workspace
  const input: DescribeWorkspaceCommandInput = {
    workspaceId: promWorkspaceId,
  };
  const command = new DescribeWorkspaceCommand(input);
  const verifyWorkspace = await client.send(command);
  if (!verifyWorkspace) {
    log
      .warn()
      .str('function', 'deletePromRulesForService')
      .str('promWorkspaceId', promWorkspaceId)
      .msg('Invalid or empty workspace details. Nothing to delete.');
    return;
  } else {
    log
      .info()
      .str('function', 'verifyPromWorkspace')
      .str('promWorkspaceId', promWorkspaceId)
      .obj('workspace', verifyWorkspace)
      .msg('Workspace exists and is active');
    return verifyWorkspace;
  }
}

/**
 * Function to manage Prometheus namespace alarms.
 * @param promWorkspaceId - The Prometheus workspace ID.
 * @param namespace - The namespace name.
 * @param ruleGroupName - The rule group name.
 * @param alarmConfigs - Array of alarm configurations.
 */
export async function managePromNamespaceAlarms(
  promWorkspaceId: string,
  namespace: string,
  ruleGroupName: string,
  // TODO Fix the use of any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  alarmConfigs: any[],
) {
  log
    .info()
    .str('function', 'managePromNamespaceAlarms')
    .str('promWorkspaceId', promWorkspaceId)
    .str('namespace', namespace)
    .str('ruleGroupName', ruleGroupName)
    .msg(
      'Starting managePromNamespaceAlarms and checking if workspace exists...',
    );

  // TODO Fix the use of any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workspaceDescription: any = await verifyPromWorkspace(promWorkspaceId);
  if (!workspaceDescription) {
    log
      .error()
      .str('function', 'managePromNamespaceAlarms')
      .str('promWorkspaceId', promWorkspaceId)
      .msg('Invalid or empty workspace details. Halting Prometheus logic.');
    throw new Error(
      'Invalid or empty workspace details. Halting Prometheus logic.',
    );
  }

  // List all existing namespaces and count total rules
  const namespaces = await listNamespaces(promWorkspaceId);
  log
    .info()
    .str('function', 'managePromNamespaceAlarms')
    .num('totalNamespaces', namespaces.length)
    .str('namespace', namespace)
    .msg('Retrieved namespaces');

  let totalWSRules = 0;
  // Count total rules across all namespaces
  for (const ns of namespaces) {
    const nsDetails = await describeNamespace(
      promWorkspaceId,
      ns.name as string,
    );
    if (nsDetails && isNamespaceDetails(nsDetails)) {
      // Add the number of rules in the current namespace to the total count
      totalWSRules += nsDetails.groups.reduce(
        (count, group) => count + group.rules.length,
        0,
      );
    }
  }
  log
    .info()
    .str('function', 'managePromNamespaceAlarms')
    .num('totalWSRules', totalWSRules)
    .msg('Total rules in workspace');

  // Check if total rules for workspace has less than 2000 rules
  if (totalWSRules >= 2000) {
    log
      .error()
      .str('function', 'managePromNamespaceAlarms')
      .msg('The workspace has 2000 or more rules. Halting Prometheus logic.');
    throw new Error(
      'The workspace has 2000 or more rules. Halting and falling back to CW Alarms.',
    );
  }

  // Check if the namespace exists
  const specificNamespace = namespaces.find((ns) => ns.name === namespace);

  if (!specificNamespace) {
    log
      .info()
      .str('function', 'managePromNamespaceAlarms')
      .msg(`No ${namespace} namespace found. Creating a new namespace.`);
    await createNamespace(promWorkspaceId, namespace, alarmConfigs);
    log
      .info()
      .str('function', 'managePromNamespaceAlarms')
      .str('namespace', namespace)
      .msg(
        'Created new namespace and added rules. Waiting 90 seconds to allow namespace to propagate.',
      );
    await wait(90000); // Wait for 90 seconds after creating the namespace
    return;
  }

  // Describe the specific namespace to get its details
  const nsDetails = await describeNamespace(promWorkspaceId, namespace);
  if (!nsDetails || !isNamespaceDetails(nsDetails)) {
    log
      .warn()
      .str('function', 'managePromNamespaceAlarms')
      .str('namespace', namespace)
      .msg('Invalid or empty namespace details, skipping');
    return;
  }

  // Sanity check: if namespace is empty, delete and recreate it
  if (nsDetails.groups.length === 0) {
    log
      .warn()
      .str('function', 'managePromNamespaceAlarms')
      .str('namespace', namespace)
      .msg(
        'Namespace is empty. Deleting and recreating it with updated rules.',
      );

    const deleteNamespaceCommand = new DeleteRuleGroupsNamespaceCommand({
      workspaceId: promWorkspaceId,
      name: namespace,
    });

    try {
      await client.send(deleteNamespaceCommand);
      log
        .info()
        .str('function', 'managePromNamespaceAlarms')
        .str('namespace', namespace)
        .msg('Deleted empty namespace.');

      await createNamespace(promWorkspaceId, namespace, alarmConfigs);
      log
        .info()
        .str('function', 'managePromNamespaceAlarms')
        .str('namespace', namespace)
        .msg('Recreated namespace with updated rules.');
      return;
    } catch (error) {
      log
        .error()
        .str('function', 'managePromNamespaceAlarms')
        .str('namespace', namespace)
        .err(error)
        .msg('Failed to delete empty namespace.');
      throw new Error(
        `Failed to delete empty namespace: ${error}. Function will be unable to proceed.`,
      );
    }
  }

  // Find the rule group within the namespace or create a new one
  const ruleGroup = nsDetails.groups.find(
    (rg): rg is RuleGroup => rg.name === ruleGroupName,
  ) || {name: ruleGroupName, rules: []};

  // Iterate over the alarm configurations and update or add rules
  for (const config of alarmConfigs) {
    // Find the index of the existing rule with the same name
    const existingRuleIndex = ruleGroup.rules.findIndex(
      (rule): rule is Rule => rule.alert === config.alarmName,
    );

    if (existingRuleIndex !== -1) {
      // If the rule exists, update its expression if it has changed
      if (ruleGroup.rules[existingRuleIndex].expr !== config.alarmQuery) {
        log
          .info()
          .str('function', 'managePromNamespaceAlarms')
          .str('namespace', namespace)
          .str('ruleGroupName', ruleGroupName)
          .str('alarmName', config.alarmName)
          .str('existingRuleIndex', ruleGroup.rules[existingRuleIndex].expr)
          .str('updated rule', config.alarmQuery)
          .msg(
            'Rule exists but expression has changed. Updating the rule expression.',
          );
        ruleGroup.rules[existingRuleIndex].expr = config.alarmQuery;
      } else {
        log
          .info()
          .str('function', 'managePromNamespaceAlarms')
          .str('namespace', namespace)
          .str('ruleGroupName', ruleGroupName)
          .str('alarmName', config.alarmName)
          .msg('Rule exists and expression is unchanged. No update needed.');
      }
    } else {
      // If the rule does not exist, add a new rule to the rule group
      log
        .info()
        .str('function', 'managePromNamespaceAlarms')
        .str('namespace', namespace)
        .str('ruleGroupName', ruleGroupName)
        .str('alarmName', config.alarmName)
        .msg('Rule does not exist. Adding new rule to the rule group.');
      ruleGroup.rules.push({
        alert: config.alarmName,
        expr: config.alarmQuery,
        for: config.duration,
        labels: {severity: config.severityType},
        annotations: {
          summary: `${config.alarmName} alert triggered`,
          description: 'The alert was triggered based on the specified query',
        },
      });
    }
  }

  // Convert the updated namespace details to YAML and encode it
  const updatedYaml = yaml.dump(nsDetails);
  const updatedData = new TextEncoder().encode(updatedYaml);

  // Create a PutRuleGroupsNamespaceCommand to update the namespace
  const putCommand = new PutRuleGroupsNamespaceCommand({
    workspaceId: promWorkspaceId,
    name: namespace,
    data: updatedData,
  });

  // Send the command to update the namespace
  try {
    await client.send(putCommand);
    log
      .info()
      .str('function', 'managePromNamespaceAlarms')
      .str('namespace', namespace)
      .msg('Updated rule group namespace');
  } catch (error) {
    log
      .error()
      .str('function', 'managePromNamespaceAlarms')
      .str('namespace', namespace)
      .err(error)
      .msg('Failed to update rule group namespace');
    throw new Error(`Failed to update rule group namespace: ${error}`);
  }
}

// Function to delete Prometheus rules for a service. For this function, the folloiwng service identifiers are used:
// ec2, ecs, eks, rds, etc. Lower case.
// ec2 - instanceID
// ecs - ...
// eks - ...
// rds - ...
export async function deletePromRulesForService(
  promWorkspaceId: string,
  service: string,
  serviceIdentifiers: string[],
): Promise<void> {
  const namespace = `AutoAlarm-${service.toUpperCase()}`;
  const ruleGroupName = 'AutoAlarm';

  const maxRetries = 60;
  const retryDelay = 5000; // 5 seconds in milliseconds
  const totalRetryTimeMinutes = (maxRetries * retryDelay) / 60000; // Total retry time in minutes

  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      // checking if the workspace exists. If not, we can return early.
      // TODO Fix the use of any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const workspaceDescription: any =
        await verifyPromWorkspace(promWorkspaceId);
      if (!workspaceDescription) {
        log
          .info()
          .str('function', 'deletePromRulesForService')
          .str('promWorkspaceId', promWorkspaceId)
          .msg('Invalid or empty workspace details. Nothing to delete.');
        return;
      }
      const nsDetails = await describeNamespace(promWorkspaceId, namespace);
      if (!nsDetails || !isNamespaceDetails(nsDetails)) {
        log
          .warn()
          .str('namespace', namespace)
          .msg('Invalid or empty namespace details. Nothing to delete.');
        return;
      }

      const ruleGroup = nsDetails.groups.find(
        (rg): rg is RuleGroup => rg.name === ruleGroupName,
      );

      if (!ruleGroup) {
        log
          .info()
          .str('function', 'deletePromRulesForService')
          .str('ruleGroupName', ruleGroupName)
          .msg('Prometheus Rule group not found, nothing to delete');
        return;
      }

      // Filter out rules associated with any of the serviceIdentifiers
      ruleGroup.rules = ruleGroup.rules.filter(
        (rule) => !serviceIdentifiers.some((id) => rule.alert.includes(id)),
      );

      if (ruleGroup.rules.length === 0) {
        // If no rules are left, remove the rule group from the namespace
        nsDetails.groups = nsDetails.groups.filter(
          (rg) => rg.name !== ruleGroupName,
        );
        log
          .info()
          .str('function', 'deletePromRulesForService')
          .str('ruleGroupName', ruleGroupName)
          .msg('No Prometheus rules left, removing the rule group');
      }

      const updatedYaml = yaml.dump(nsDetails);

      if (updatedYaml === 'groups: []\n') {
        // If updated YAML is empty, delete the namespace
        log
          .info()
          .str('function', 'deletePromRulesForService')
          .str('namespace', namespace)
          .str('config YAML', updatedYaml)
          .msg('No rules left in namespace, deleting the namespace');
        const deleteNamespaceCommand = new DeleteRuleGroupsNamespaceCommand({
          workspaceId: promWorkspaceId,
          name: namespace,
        });

        try {
          await client.send(deleteNamespaceCommand);
          log
            .info()
            .str('function', 'deletePromRulesForService')
            .str('namespace', namespace)
            .msg('Namespace deleted as it has no rule groups left.');
          return;
        } catch (error) {
          log
            .error()
            .str('function', 'deletePromRulesForService')
            .str('namespace', namespace)
            .err(error)
            .msg('Failed to delete namespace');
          throw new Error(`Failed to delete namespace: ${error}`);
        }
      } else {
        const updatedData = new TextEncoder().encode(updatedYaml);

        const putCommand = new PutRuleGroupsNamespaceCommand({
          workspaceId: promWorkspaceId,
          name: namespace,
          data: updatedData,
        });

        await client.send(putCommand);
        log
          .info()
          .str('function', 'deletePromRulesForService')
          .str('namespace', namespace)
          .str('service', service)
          .str('serviceIdentifiers', JSON.stringify(serviceIdentifiers))
          .str('ruleGroupName', ruleGroupName)
          .msg('Deleted Prometheus rules associated with the service.');
        return;
      }
    } catch (error) {
      log
        .warn()
        .str('function', 'deletePromRulesForService')
        .num('retryCount', retryCount + 1)
        .obj('error', error as object)
        .msg(
          `Retry ${retryCount + 1}/${maxRetries} failed. Retrying in ${
            retryDelay / 1000
          } seconds...`,
        );

      if (++retryCount >= maxRetries) {
        throw new Error(
          `Failed to complete operation after ${maxRetries} retries (${totalRetryTimeMinutes} minutes): ${error}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}
