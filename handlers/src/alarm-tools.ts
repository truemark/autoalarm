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
// serviceIdentifier should be all UPPER CASE
// instance identifier should be the identifier that is use for cloudwatch to pull alarm information. When adding a new service
// list it here below:
// EC2: instanceID
// ECS: ...
// EKS: ...
// RDS: ...
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
    log
      .info()
      .str('serviceIdentifier', serviceIdentifier)
      .str('instanceIdentifier', instanceIdentifier)
      .str(
        'alarm prefix',
        `AutoAlarm-${serviceIdentifier}-${instanceIdentifier}`
      )
      .msg('Filtering alarms by name');
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
      .str('function', 'deleteCWAlarm')
      .str('alarmName', alarmName)
      .str('instanceId', instanceIdentifier)
      .msg('Attempting to delete alarm');
    await cloudWatchClient.send(
      new DeleteAlarmsCommand({AlarmNames: [alarmName]})
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

  // Log the request details before signing
  log
    .info()
    .str('hostname', hostname)
    .str('path', path)
    .str('region', region)
    .msg('Request details before signing');

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
          log
            .info()
            .str('parsedData', JSON.stringify(parsedData, null, 2))
            .msg('Parsed response data');
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
  region: string
): Promise<string[]> {
  const queryPath = `/workspaces/${promWorkspaceID}/api/v1/query?query=`;

  try {
    let query = '';
    switch (serviceType) {
      case 'ec2': {
        log
          .info()
          .str('function', 'queryPrometheusForService')
          .str('serviceType', serviceType)
          .str('promWorkspaceID', promWorkspaceID)
          .str('region', region)
          .msg('Querying Prometheus for EC2 instances');

        query = 'up{job="ec2"}';

        log
          .info()
          .str('function', 'queryPrometheusForService')
          .str('fullQueryPath', queryPath + encodeURIComponent(query))
          .msg('Full query path');

        const response = await makeSignedRequest(
          queryPath + encodeURIComponent(query),
          region
        );

        log
          .info()
          .str('function', 'queryPrometheusForService')
          .str('serviceType', serviceType)
          .str('Prometheus Workspace ID', promWorkspaceID)
          .str('region', region)
          .str('response', JSON.stringify(response, null, 2))
          .msg('Raw Prometheus query result');

        if (
          !response ||
          response.status !== 'success' ||
          !response.data ||
          !response.data.result
        ) {
          log
            .warn()
            .str('function', 'queryPrometheusForService')
            .str('serviceType', serviceType)
            .str('Prometheus Workspace ID', promWorkspaceID)
            .str('response', JSON.stringify(response, null, 2))
            .msg(
              'Prometheus query failed or returned unexpected structure. Defaulting to CW Alarms if possible...'
            );
          return [];
        }

        // Extract unique instances private IPs from query results
        const instances = new Set<string>();
        response.data.result.forEach((item: any) => {
          const instance = item.metric.instance.split(':')[0];
          instances.add(instance);
        });

        log
          .info()
          .str('function', 'queryPrometheusForService')
          .str('serviceType', serviceType)
          .str('Prometheus Workspace ID', promWorkspaceID)
          .str('instances', JSON.stringify(Array.from(instances)))
          .msg('Unique instances extracted from Prometheus response');

        return Array.from(instances);
      }
      default: {
        log
          .warn()
          .str('function', 'queryPrometheusForService')
          .str('serviceType', serviceType)
          .msg('Unsupported service type. Defaulting to CW Alarms if possible');
        return [];
      }
    }
  } catch (error) {
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

// Function to describe a namespace
export const describeNamespace = async (
  workspaceId: string,
  namespace: string,
  retries = 2
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

  for (let attempt = 0; attempt <= retries; attempt++) {
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
        .msg(
          `Error describing namespace, attempt ${attempt + 1} of ${retries + 1}`
        );
      if (attempt < retries) {
        log
          .info()
          .str('function', 'describeNamespace')
          .msg('Retrying in 90 seconds...');
        await new Promise(resolve => setTimeout(resolve, 90 * 1000)); // Wait for 90 seconds before retrying
      } else {
        log
          .error()
          .str('function', 'describeNamespace')
          .str('namespace', namespace)
          .msg('Ran out of attempts');
        throw error; // If it's the last attempt, rethrow the error
      }
    }
  }
  return null; // Ensure that the function always returns a value
};

// Function to create a new namespace
async function createNamespace(
  promWorkspaceId: string,
  namespace: string,
  alarmConfigs: any[]
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
        rules: alarmConfigs.map(config => ({
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
  alarmConfigs: any[]
) {
  log
    .info()
    .str('function', 'managePromNamespaceAlarms')
    .str('promWorkspaceId', promWorkspaceId)
    .str('namespace', namespace)
    .str('ruleGroupName', ruleGroupName)
    .msg('Starting managePromNamespaceAlarms');

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
      ns.name as string
    );
    if (nsDetails && isNamespaceDetails(nsDetails)) {
      // Add the number of rules in the current namespace to the total count
      totalWSRules += nsDetails.groups.reduce(
        (count, group) => count + group.rules.length,
        0
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
      'The workspace has 2000 or more rules. Halting and falling back to CW Alarms.'
    );
  }

  // Check if the namespace exists
  const specificNamespace = namespaces.find(ns => ns.name === namespace);

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
        'Created new namespace and added rules. Waiting 90 seconds to allow namespace to propagate.'
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

  // Find the rule group within the namespace or create a new one
  const ruleGroup = nsDetails.groups.find(
    (rg): rg is RuleGroup => rg.name === ruleGroupName
  ) || {name: ruleGroupName, rules: []};

  // Iterate over the alarm configurations and update or add rules
  for (const config of alarmConfigs) {
    // Find the index of the existing rule with the same name
    const existingRuleIndex = ruleGroup.rules.findIndex(
      (rule): rule is Rule => rule.alert === config.alarmName
    );

    if (existingRuleIndex !== -1) {
      // If the rule exists, update its expression if it has changed
      if (ruleGroup.rules[existingRuleIndex].expr !== config.alarmQuery) {
        ruleGroup.rules[existingRuleIndex].expr = config.alarmQuery;
      }
    } else {
      // If the rule does not exist, add a new rule to the rule group
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
  await client.send(putCommand);
  log
    .info()
    .str('function', 'managePromNamespaceAlarms')
    .str('namespace', namespace)
    .msg('Updated rule group namespace');

  // Wait for 90 seconds after adding or updating a rule to allow for propagation
  await wait(90000);
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
  try {
    const namespace = `AutoAlarm-${service.toUpperCase()}`;
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
        .str('function', 'deletePromRulesForService')
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
        .str('function', 'deletePromRulesForService')
        .str('ruleGroupName', ruleGroupName)
        .msg('No Prometheus rules left, removing the rule group');
    }
    log
      .info()
      .str('function', 'deletePromRulesForService')
      .str('promWorkspaceId', promWorkspaceId)
      .str('service', service)
      .str('serviceIdentifier', serviceIdentifier)
      .msg(
        'Waiting 90 seconds to allow any rule updates to finish and then starting deletePromRulesForService'
      );

    await wait(90000); // Wait for 90 seconds before deleting the rules
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
      .str('function', 'deletePromRulesForService')
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
