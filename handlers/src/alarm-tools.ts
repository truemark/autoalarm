import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
  PutMetricAlarmCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  AmpClient,
  ListRuleGroupsNamespacesCommand,
  DescribeRuleGroupsNamespaceCommand,
  CreateRuleGroupsNamespaceCommand,
  PutRuleGroupsNamespaceCommand,
  RuleGroupsNamespaceSummary,
} from '@aws-sdk/client-amp';
import * as yaml from 'js-yaml';
import * as aws4 from 'aws4';
import {defaultProvider} from '@aws-sdk/credential-provider-node';
import * as logging from '@nr1e/logging';
import {AlarmProps, Tag, RuleGroup, NamespaceDetails, Rule} from './types';
import * as https from 'https';
import {AlarmClassification} from './enums';

const log = logging.getRootLogger();
const cloudWatchClient = new CloudWatchClient({});
const region: string = process.env.AWS_REGION || '';
const client = new AmpClient({region, credentials: defaultProvider()}); //used for Prometheus

export async function doesAlarmExist(alarmName: string): Promise<boolean> {
  const response = await cloudWatchClient.send(
    new DescribeAlarmsCommand({AlarmNames: [alarmName]})
  );
  return (response.MetricAlarms?.length ?? 0) > 0;
}

export async function CWAlarmNeedsUpdate(
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

export async function createOrUpdateCWAlarm(
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

// This function is used to grab all active CW auto alarms for a given instance and then pushes those to the activeAutoAlarms array
// which it returns to be used when the deleteCWAlarm function is called from within service module files.
// service identifier should be lowercase e.g. ec2, ecs, eks, rds, etc.
// instance identifier should be the identifier that is use for cloudwatch to pull alarm information. When add a new service
// list it here below:
// ec2: instanceID
// ecs: ...
// eks: ...
// rds: ...
export async function getCWAlarmsForInstance(
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

export async function deleteCWAlarm(
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

/*
 * All Fucntions Below this point are used to interact with Promehteus and check
 */

// We use the following const to make a signed http request for the prom APIs following patterns found in this example:
// https://github.com/aws-samples/sigv4-signing-examples/blob/main/sdk/nodejs/main.js. We use defaultProvider to get the
// credentials needed to sign the request. We then sign the request using aws4 and make the request using https.request.
const makeSignedRequest = async (
  path: string,
  region: string
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
      host: hostname,
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
    }
  );

  // Add signed headers to the request options
  Object.assign(options.headers, signer.headers);

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        log
          .info()
          .num('statusCode', res.statusCode || 0)
          .str('headers', JSON.stringify(res.headers, null, 2))
          .str('body', data)
          .msg('Response received');

        try {
          const parsedData = JSON.parse(data);
          resolve(parsedData);
        } catch (error) {
          log
            .error()
            .err(error)
            .str('rawData', data)
            .msg('Failed to parse response data');
          reject(error);
        }
      });
    });

    req.on('error', error => {
      log.error().err(error).msg('Request error');
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

export async function queryPrometheusForService(
  serviceType: string,
  serviceIdentifier: string,
  promWorkspaceID: string,
  region: string
): Promise<boolean> {
  const queryPath = `/workspaces/${promWorkspaceID}/api/v1/query?query=`;

  try {
    let query = '';
    switch (serviceType) {
      case 'ec2': {
        log
          .info()
          .str('serviceType', serviceType)
          .str('serviceIdentifier', serviceIdentifier)
          .str('promWorkspaceID', promWorkspaceID)
          .str('region', region)
          .msg('Querying Prometheus for EC2 instances');

        query = 'up{job="ec2"}';

        log
          .info()
          .str('fullQueryPath', queryPath + encodeURIComponent(query))
          .msg('Full query path');

        const response = await makeSignedRequest(
          queryPath + encodeURIComponent(query),
          region
        );

        if (response.status !== 'success') {
          log
            .warn()
            .str('serviceType', serviceType)
            .str('serviceIdentifier', serviceIdentifier)
            .str('Prometheus Workspace ID', promWorkspaceID)
            .str('response', JSON.stringify(response, null, 2))
            .msg(
              'Prometheus query failed. Defaulting to CW Alarms if possible...'
            );
          return false;
        }

        const ipAddresses = response.data.result.map((item: any) => {
          const instance = item.metric.instance;
          const ipAddr = instance.split(':')[0];
          return ipAddr;
        });

        log
          .info()
          .str('serviceType', serviceType)
          .str('serviceIdentifier', serviceIdentifier)
          .str('Prometheus Workspace ID', promWorkspaceID)
          .str('ipAddresses', JSON.stringify(ipAddresses))
          .msg('IP addresses extracted from Prometheus response.');

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
    log
      .error()
      .err(error)
      .str('serviceType', serviceType)
      .str('serviceIdentifier', serviceIdentifier)
      .str('Prometheus Workspace ID', promWorkspaceID)
      .str('region', region)
      .msg('Error querying Prometheus');
    return false;
  }
}

// Check if the Prometheus tag is set to true and if metrics are being sent to Prometheus
export async function isPromEnabled(
  instanceId: string,
  serviceType: string,
  serviceIdentifier: string,
  promWorkspaceId: string,
  tags: {[key: string]: string}
): Promise<boolean> {
  try {
    const prometheusTag = tags['Prometheus'];
    if (prometheusTag === 'true') {
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
      /* The following conditional is used to check if the useProm variable is true or false. This will be used to
      determine if metrics are being sent to Prometheus. Specifically, since we use the privet IP address of the instance
      to verify we can match up instances with alarms, this also confirms we are abel to pull the required metadata to
      create alarms for the instances that are triggering the lambda.
       */
      if (!useProm) {
        log
          .warn()
          .str('instanceId', instanceId)
          .msg('Metrics are not being sent to Prometheus');
        return false;
      }
      log
        .info()
        .str('instanceId', instanceId)
        .msg(`Prometheus metrics enabled=${useProm}`);
      return true; //this will be used for the useProm variable once we finish testing the initial logic
    } else if (prometheusTag === 'false' || !prometheusTag) {
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

const listNamespaces = async (
  workspaceId: string
): Promise<RuleGroupsNamespaceSummary[]> => {
  const maxRetries = 2;
  const retryDelay = 60000; // 60 seconds
  const command = new ListRuleGroupsNamespacesCommand({workspaceId});
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      const response = await client.send(command);
      log
        .info()
        .str('response', JSON.stringify(response))
        .msg('Successfully listed namespaces');
      return response.ruleGroupsNamespaces ?? [];
    } catch (error) {
      retryCount++;
      log
        .warn()
        .num('retryCount', retryCount)
        .msg(
          `Error listing namespaces, retrying in ${retryDelay / 1000} seconds`
        );
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      if (retryCount === maxRetries) {
        log
          .error()
          .err(error)
          .msg('Error listing namespaces after maximum retries');
        throw error;
      }
    }
  }
  return [];
};

const describeNamespace = async (workspaceId: string, namespace: string) => {
  const command = new DescribeRuleGroupsNamespaceCommand({
    workspaceId,
    name: namespace,
  });
  log
    .info()
    .str('workspaceId', workspaceId)
    .str('namespace', namespace)
    .msg('Describing namespace');
  try {
    const response = await client.send(command);
    if (response.ruleGroupsNamespace) {
      const dataStr = new TextDecoder().decode(
        response.ruleGroupsNamespace.data
      );
      log.info().str('rawData', dataStr).msg('Raw data from API');
      try {
        const nsDetails = yaml.load(dataStr) as NamespaceDetails;
        if (!isNamespaceDetails(nsDetails)) {
          throw new Error('Invalid namespace details structure');
        }
        log
          .info()
          .str('namespace', namespace)
          .str('details', JSON.stringify(nsDetails))
          .msg('Namespace described');
        return nsDetails;
      } catch (parseError) {
        log
          .error()
          .err(parseError)
          .str('rawData', dataStr)
          .msg('Failed to parse namespace data');
        throw parseError;
      }
    }
    log
      .warn()
      .str('namespace', namespace)
      .msg('No data returned for namespace');
    return null;
  } catch (error) {
    log.error().err(error).msg('Error describing namespace');
    throw error;
  }
};

const createNamespace = async (workspaceId: string, namespace: string) => {
  const initialNamespace: NamespaceDetails = {
    groups: [
      {
        name: 'initial_group',
        rules: [
          {
            alert: 'placeholder_alert',
            expr: 'vector(1)',
            for: '1m',
            labels: {severity: 'info'},
            annotations: {
              summary: 'Placeholder alert',
              description:
                'This is a placeholder alert to initialize the namespace.',
            },
          },
        ],
      },
    ],
  };
  const initialYaml = yaml.dump(initialNamespace);

  const command = new CreateRuleGroupsNamespaceCommand({
    workspaceId,
    name: namespace,
    data: new TextEncoder().encode(initialYaml),
  });
  log
    .info()
    .str('namespace', namespace)
    .msg('Creating new Prometheus namespace');
  try {
    await client.send(command);
    log
      .info()
      .str('namespace', namespace)
      .msg('Created new Prometheus namespace');
  } catch (error) {
    log.error().err(error).msg('Error creating namespace');
    throw error;
  }
};

// Helper function to ensure that the object is a NamespaceDetails interface
function isNamespaceDetails(obj: unknown): obj is NamespaceDetails {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'groups' in obj &&
    Array.isArray((obj as NamespaceDetails).groups)
  );
}

const putRuleGroupNamespace = async (
  workspaceId: string,
  namespace: string,
  ruleGroupName: string,
  alarmName: string,
  alarmQuery: string,
  duration: string,
  severityType: AlarmClassification
): Promise<void> => {
  log
    .info()
    .str('workspaceId', workspaceId)
    .str('namespace', namespace)
    .str('ruleGroupName', ruleGroupName)
    .str('alarmName', alarmName)
    .msg('Starting putRuleGroupNamespace');

  const maxRetries = 5;
  const retryDelay = 5000;
  const command = new DescribeRuleGroupsNamespaceCommand({
    workspaceId,
    name: namespace,
  });

  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      const response = await client.send(command);
      if (response.ruleGroupsNamespace) {
        const dataStr = new TextDecoder().decode(
          response.ruleGroupsNamespace.data
        );
        const nsDetails: NamespaceDetails = yaml.load(
          dataStr
        ) as NamespaceDetails;

        let ruleGroup = nsDetails.groups.find(
          group => group.name === ruleGroupName
        );
        if (!ruleGroup) {
          ruleGroup = {name: ruleGroupName, rules: []};
          nsDetails.groups.push(ruleGroup);
        }

        const existingRuleIndex = ruleGroup.rules.findIndex(
          (rule): rule is Rule => rule.alert === alarmName
        );
        if (existingRuleIndex !== -1) {
          // Remove the existing rule and add the new rule
          ruleGroup.rules.splice(existingRuleIndex, 1, {
            alert: alarmName,
            expr: alarmQuery,
            for: duration,
            labels: {
              severity: severityType,
            },
            annotations: {
              summary: `${alarmName} alert triggered`,
              description:
                'The alert was triggered based on the specified query',
            },
          });
        } else {
          ruleGroup.rules.push({
            alert: alarmName,
            expr: alarmQuery,
            for: duration,
            labels: {
              severity: severityType,
            },
            annotations: {
              summary: `${alarmName} alert triggered`,
              description:
                'The alert was triggered based on the specified query',
            },
          });
        }

        const updatedYaml = yaml.dump(nsDetails);
        const updatedData = new TextEncoder().encode(updatedYaml);

        const putCommand = new PutRuleGroupsNamespaceCommand({
          workspaceId,
          name: namespace,
          data: updatedData,
        });

        await client.send(putCommand);
        log
          .info()
          .str('namespace', namespace)
          .msg('Updated rule group namespace');
        return;
      } else {
        log
          .warn()
          .str('namespace', namespace)
          .msg('No RuleGroupsNamespace found');
        return; // Exit if no namespace is found
      }
    } catch (error) {
      retryCount++;
      log
        .warn()
        .str('namespace', namespace)
        .num('retryCount', retryCount)
        .msg('Error encountered, retrying after delay');
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      if (retryCount === maxRetries) {
        log.error().err(error).msg('Error putting rule group namespace');
        throw error;
      }
    }
  }

  throw new Error(
    `Failed to update rule group namespace ${namespace} after ${maxRetries} retries`
  );
};

export async function managePromNameSpaceAlarms(
  promWorkspaceId: string,
  service: string,
  metric: string,
  alarmName: string,
  alarmQuery: string,
  duration: string,
  severityType: AlarmClassification
) {
  log
    .info()
    .str('promWorkspaceId', promWorkspaceId)
    .str('service', service)
    .str('metric', metric)
    .str('alarmName', alarmName)
    .str('alarmQuery', alarmQuery)
    .msg('Starting managePromNameSpaceAlarms');

  const nsDelay = 60000; // 60 seconds to give namespace time to create if needed
  // List all existing namespaces
  const namespacesResult = await listNamespaces(promWorkspaceId);
  const rootNamespace = `AutoAlarm-${service.toUpperCase()}-${metric.toUpperCase()}`;

  // Type guard to ensure namespacesResult is an array
  if (!Array.isArray(namespacesResult)) {
    log
      .error()
      .str('namespacesResult', JSON.stringify(namespacesResult))
      .msg('Expected an array of namespaces, but received a different type');
    return;
  }

  const namespaces = namespacesResult;
  log
    .info()
    .num('totalNamespaces', namespaces.length)
    .str('rootNamespace', rootNamespace)
    .msg('Retrieved namespaces');

  // If no namespaces exist, create a new one
  if (namespaces.length === 0) {
    log.info().msg('No namespaces found. Creating a new namespace.');
    const newNamespace = `${rootNamespace}-1`;
    await new Promise(resolve => setTimeout(resolve, nsDelay));
    await createNamespace(promWorkspaceId, newNamespace);
    await putRuleGroupNamespace(
      promWorkspaceId,
      newNamespace,
      `AutoAlarm-${service}-${metric}`,
      alarmName,
      alarmQuery,
      duration,
      severityType
    );
    log
      .info()
      .str('newNamespace', newNamespace)
      .msg('Created new namespace and added rule');
    return;
  }

  let maxNamespaceIndex = 0;
  const ruleGroupName = `AutoAlarm-${service}-${metric}`;
  let updated = false;

  // Iterate through existing namespaces
  for (const ns of namespaces) {
    if (ns.name && ns.name.startsWith(rootNamespace)) {
      log.info().str('namespace', ns.name).msg('Checking namespace');

      // Keep track of the highest namespace index
      const nsIndex = parseInt(ns.name.replace(`${rootNamespace}-`, ''), 10);
      if (!isNaN(nsIndex) && nsIndex > maxNamespaceIndex) {
        maxNamespaceIndex = nsIndex;
        log
          .info()
          .num('maxNamespaceIndex', maxNamespaceIndex)
          .msg('Updated maxNamespaceIndex');
      }

      // Describe the namespace to get its details
      const nsDetails = await describeNamespace(promWorkspaceId, ns.name);
      if (!nsDetails || !isNamespaceDetails(nsDetails)) {
        log
          .warn()
          .str('namespace', ns.name)
          .msg('Invalid or empty namespace details, skipping');
        continue;
      }

      const rules = nsDetails.groups || [];
      log
        .info()
        .str('namespace', ns.name)
        .num('rulesCount', rules.length)
        .msg('Checking if namespace has <1000 rules');

      // Check if the namespace has less than 1000 rules
      if (rules.length < 1000) {
        log
          .info()
          .str('namespace', ns.name)
          .msg('Namespace has < 1000 rules, checking for rule group');

        // Check if the rule group already exists
        let ruleGroup = rules.find(
          (rg): rg is RuleGroup => rg.name === ruleGroupName
        );
        if (ruleGroup) {
          log
            .info()
            .str('ruleGroupName', ruleGroupName)
            .msg(
              'Rule group found. Checking if rule query values match updated tags...'
            );

          const existingRuleIndex = ruleGroup.rules.findIndex(
            (rule): rule is Rule => rule.alert === alarmName
          );
          if (existingRuleIndex !== -1) {
            log
              .info()
              .str('alarmName', alarmName)
              .msg('Rule already exists, replacing it');
            ruleGroup.rules.splice(existingRuleIndex, 1);
            ruleGroup.rules.push({
              alert: alarmName,
              expr: alarmQuery,
              for: duration,
              labels: {severity: severityType},
              annotations: {
                summary: `${alarmName} alert triggered`,
                description:
                  'The alert was triggered based on the specified query',
              },
            });
            await putRuleGroupNamespace(
              promWorkspaceId,
              ns.name,
              ruleGroupName,
              alarmName,
              alarmQuery,
              duration,
              severityType
            );
            log
              .info()
              .str('alarmName', alarmName)
              .msg('Rule replaced successfully');
            updated = true;
            break;
          } else {
            // Add new rule to the existing rule group
            log.info().msg('Attempting to add new rule to existing rule group');
            ruleGroup.rules.push({
              alert: alarmName,
              expr: alarmQuery,
              for: duration,
              labels: {severity: severityType},
              annotations: {
                summary: `${alarmName} alert triggered`,
                description:
                  'The alert was triggered based on the specified query',
              },
            });
            await putRuleGroupNamespace(
              promWorkspaceId,
              ns.name,
              ruleGroupName,
              alarmName,
              alarmQuery,
              duration,
              severityType
            );
            log
              .info()
              .str('alarmName', alarmName)
              .msg('New rule added to existing group successfully');
            updated = true;
            break;
          }
        } else {
          // Add new rule group with the alarm
          log
            .info()
            .str('ruleGroupName', ruleGroupName)
            .msg('Rule group not found. Adding new rule group with alarm');
          ruleGroup = {
            name: ruleGroupName,
            rules: [
              {
                alert: alarmName,
                expr: alarmQuery,
                for: duration,
                labels: {severity: severityType},
                annotations: {
                  summary: `${alarmName} alert triggered`,
                  description:
                    'The alert was triggered based on the specified query',
                },
              },
            ],
          };
          nsDetails.groups.push(ruleGroup);
          await putRuleGroupNamespace(
            promWorkspaceId,
            ns.name,
            ruleGroupName,
            alarmName,
            alarmQuery,
            duration,
            severityType
          );
          log
            .info()
            .str('ruleGroupName', ruleGroupName)
            .str('alarmName', alarmName)
            .msg('New rule group and alarm added successfully');
          updated = true;
          break;
        }
      }
    }
  }

  // Create a new namespace if no suitable namespace was found or rule was not updated
  if (!updated) {
    log.info().msg('No suitable namespace found. Creating a new namespace');
    const newNamespace = `${rootNamespace}-${maxNamespaceIndex + 1}`;
    await createNamespace(promWorkspaceId, newNamespace);
    log.info().str('newNamespace', newNamespace).msg('New namespace created');

    // Create the new rule group in the new namespace
    await putRuleGroupNamespace(
      promWorkspaceId,
      newNamespace,
      ruleGroupName,
      alarmName,
      alarmQuery,
      duration,
      severityType
    );
    log
      .info()
      .str('newNamespace', newNamespace)
      .str('ruleGroupName', ruleGroupName)
      .str('alarmName', alarmName)
      .msg('New rule group and alarm added to new namespace');
  }

  log.info().msg('managePromNameSpaceAlarms completed');
}
