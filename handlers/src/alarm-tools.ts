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

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Function to list namespaces
const listNamespaces = async (
  workspaceId: string
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

// Function to create a new namespace
const createNamespace = async (
  workspaceId: string,
  namespace: string,
  alarmName: string,
  alarmQuery: string,
  duration: string,
  severityType: string
) => {
  const initialNamespace: NamespaceDetails = {
    groups: [
      {
        name: 'AutoAlarm',
        rules: [
          {
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
    await wait(90000); // Wait for 90 seconds after creating the namespace
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

// Function to update or create a rule group within a namespace
const putRuleGroupNamespace = async (
  workspaceId: string,
  namespace: string,
  ruleGroupName: string,
  alarmName: string,
  alarmQuery: string,
  duration: string,
  severityType: string
): Promise<void> => {
  log
    .info()
    .str('workspaceId', workspaceId)
    .str('namespace', namespace)
    .str('ruleGroupName', ruleGroupName)
    .str('alarmName', alarmName)
    .msg('Starting putRuleGroupNamespace');

  const maxRetries = 3;
  const retryDelay = 90000;
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
          ruleGroup.rules[existingRuleIndex].expr = alarmQuery;
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
        await wait(90000); // Wait for 90 seconds after adding or updating a rule
        return;
      } else {
        log
          .warn()
          .str('namespace', namespace)
          .msg('No RuleGroupsNamespace found');
      }
    } catch (error) {
      retryCount++;
      log
        .warn()
        .str('namespace', namespace)
        .num('retryCount', retryCount)
        .str('error', JSON.stringify(error))
        .msg(
          'Namespace is updating or running into another issue, retrying after delay'
        );
      await wait(retryDelay);
      if (retryCount === maxRetries) {
        log.error().err(error).msg('Error putting rule group namespace');
        throw error;
      }
    }
  }
};

// Function to manage Prometheus namespace alarms
export async function managePromNameSpaceAlarms(
  promWorkspaceId: string,
  service: string,
  metric: string,
  alarmName: string,
  alarmQuery: string,
  duration: string,
  severityType: string
) {
  log
    .info()
    .str('promWorkspaceId', promWorkspaceId)
    .str('service', service)
    .str('metric', metric)
    .str('alarmName', alarmName)
    .str('alarmQuery', alarmQuery)
    .msg('Starting managePromNameSpaceAlarms');

  // List all existing namespaces and count total rules
  const namespaces = await listNamespaces(promWorkspaceId);
  const rootNamespace = 'AutoAlarm';

  log
    .info()
    .num('totalNamespaces', namespaces.length)
    .str('rootNamespace', rootNamespace)
    .msg('Retrieved namespaces');

  let totalWSRules = 0;
  // Count total rules across all namespaces
  for (const ns of namespaces) {
    const nsDetails = await describeNamespace(
      promWorkspaceId,
      ns.name as string
    );
    if (nsDetails && isNamespaceDetails(nsDetails)) {
      totalWSRules += nsDetails.groups.reduce(
        (count, group) => count + group.rules.length,
        0
      );
    }
  }
  log.info().num('totalWSRules', totalWSRules).msg('Total rules in workspace');

  // Check if total rules for workspace has less than 2000 rules
  if (totalWSRules >= 2000) {
    log
      .error()
      .msg('The workspace has 2000 or more rules. Halting Prometheus logic.');
    throw new Error(
      'The workspace has 2000 or more rules. Halting and falling back to CW Alarms.'
    );
  }

  // Check if AutoAlarm namespace exists
  const autoAlarmNamespace = namespaces.find(ns => ns.name === rootNamespace);

  if (!autoAlarmNamespace) {
    log.info().msg('No AutoAlarm namespace found. Creating a new namespace.');
    await createNamespace(
      promWorkspaceId,
      rootNamespace,
      alarmName,
      alarmQuery,
      duration,
      severityType
    );
    log
      .info()
      .str('namespace', rootNamespace)
      .msg('Created new namespace and added rule');
    return;
  }

  // Describe the AutoAlarm namespace to get its details
  const nsDetails = await describeNamespace(promWorkspaceId, rootNamespace);
  if (!nsDetails || !isNamespaceDetails(nsDetails)) {
    log
      .warn()
      .str('namespace', rootNamespace)
      .msg('Invalid or empty namespace details, skipping');
    return;
  }

  const rules =
    nsDetails.groups.find((rg): rg is RuleGroup => rg.name === 'AutoAlarm')
      ?.rules || [];
  log
    .info()
    .str('namespace', rootNamespace)
    .num('rulesCount', rules.length)
    .msg('Checking if namespace has <1000 rules');

  // Check if the namespace has less than 1000 rules
  if (rules.length >= 1000) {
    log
      .error()
      .msg(
        'The AutoAlarm namespace has 1000 or more rules. Halting Prometheus logic.'
      );
    throw new Error('The AutoAlarm namespace has 1000 or more rules.');
  }

  // Check if the rule group already exists
  const ruleGroup = nsDetails.groups.find(
    (rg): rg is RuleGroup => rg.name === 'AutoAlarm'
  );

  if (ruleGroup) {
    log
      .info()
      .str('ruleGroupName', 'AutoAlarm')
      .msg(
        'Rule group found. Checking if rule query values match updated tags...'
      );

    const existingRuleIndex = ruleGroup.rules.findIndex(
      (rule): rule is Rule => rule.alert === alarmName
    );
    if (existingRuleIndex !== -1) {
      log
        .info()
        .msg(
          'Tag values differ from existing rule query. Updating the rule...'
        );
      // Remove the existing rule and add the new rule
      ruleGroup.rules.splice(existingRuleIndex, 1);
    }

    ruleGroup.rules.push({
      alert: alarmName,
      expr: alarmQuery,
      for: duration,
      labels: {severity: severityType},
      annotations: {
        summary: `${alarmName} alert triggered`,
        description: 'The alert was triggered based on the specified query',
      },
    });
    await putRuleGroupNamespace(
      promWorkspaceId,
      rootNamespace,
      'AutoAlarm',
      alarmName,
      alarmQuery,
      duration,
      severityType
    );
    log.info().str('alarmName', alarmName).msg('Rule updated successfully');
  } else {
    // Add new rule group with the alarm
    log
      .info()
      .str('ruleGroupName', 'AutoAlarm')
      .msg('Rule group not found. Adding new rule group with alarm');
    nsDetails.groups.push({
      name: 'AutoAlarm',
      rules: [
        {
          alert: alarmName,
          expr: alarmQuery,
          for: duration,
          labels: {severity: severityType},
          annotations: {
            summary: `${alarmName} alert triggered`,
            description: 'The alert was triggered based on the specified query',
          },
        },
      ],
    });
    await putRuleGroupNamespace(
      promWorkspaceId,
      rootNamespace,
      'AutoAlarm',
      alarmName,
      alarmQuery,
      duration,
      severityType
    );
    log
      .info()
      .str('ruleGroupName', 'AutoAlarm')
      .str('alarmName', alarmName)
      .msg('New rule group and alarm added successfully');
  }

  log.info().msg('managePromNameSpaceAlarms completed');
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
  serviceIdentifier: string
): Promise<void> {
  log
    .info()
    .str('promWorkspaceId', promWorkspaceId)
    .str('service', service)
    .str('serviceIdentifier', serviceIdentifier)
    .msg('Starting deletePromRulesForService');

  try {
    const namespace = 'AutoAlarm';
    const ruleGroupName = 'AutoAlarm';

    // Describe the namespace to get its details
    const nsDetails = await describeNamespace(promWorkspaceId, namespace);
    if (!nsDetails || !isNamespaceDetails(nsDetails)) {
      log
        .warn()
        .str('namespace', namespace)
        .msg('Invalid or empty namespace details');
      return;
    }

    const ruleGroup = nsDetails.groups.find(
      (rg): rg is RuleGroup => rg.name === ruleGroupName
    );

    if (!ruleGroup) {
      log
        .info()
        .str('ruleGroupName', ruleGroupName)
        .msg('Prometheus Rule group not found, nothing to delete');
      return;
    }

    // Filter out rules associated with the instanceId
    ruleGroup.rules = ruleGroup.rules.filter(
      rule => !rule.alert.includes(serviceIdentifier)
    );

    if (ruleGroup.rules.length === 0) {
      // If no rules are left, remove the rule group from the namespace
      nsDetails.groups = nsDetails.groups.filter(
        rg => rg.name !== ruleGroupName
      );
      log
        .info()
        .str('ruleGroupName', ruleGroupName)
        .msg('No Prometheus rules left, removing the rule group');
    }

    const updatedYaml = yaml.dump(nsDetails);
    const updatedData = new TextEncoder().encode(updatedYaml);

    const putCommand = new PutRuleGroupsNamespaceCommand({
      workspaceId: promWorkspaceId,
      name: namespace,
      data: updatedData,
    });

    await client.send(putCommand);
    log
      .info()
      .str('namespace', namespace)
      .str('service', service)
      .str('serviceIdentifier', serviceIdentifier)
      .str('ruleGroupName', ruleGroupName)
      .str('instanceId', serviceIdentifier)
      .msg('Deleted prometheus rules associated with the service.');
    await wait(90000); // Wait for 90 seconds after deleting the rules
  } catch (error) {
    log.error().err(error).msg('Error deleting rules');
    throw error;
  }
}


