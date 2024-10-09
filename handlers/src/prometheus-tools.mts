import * as logging from '@nr1e/logging';
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
import {
  RuleGroup,
  NamespaceDetails,
  Rule,
  Tag,
  EC2AlarmManagerArray,
} from './types.mjs';
import {AlarmClassification} from './enums.mjs';
import * as yaml from 'js-yaml';
import * as aws4 from 'aws4';
import * as https from 'https';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {defaultProvider} from '@aws-sdk/credential-provider-node';

const log: logging.Logger = logging.getLogger('ec2-modules');
const retryStrategy = new ConfiguredRetryStrategy(20);
//the following environment variables are used to get the prometheus workspace id and the region
export const prometheusWorkspaceId: string =
  process.env.PROMETHEUS_WORKSPACE_ID || '';
const region: string = process.env.AWS_REGION || '';
const client = new AmpClient({
  region,
  credentials: defaultProvider(),
  retryStrategy: retryStrategy,
});

/**
 * This function is used to delete all prom rules in batch for instances that have been marked for Prom rule deletion.
 * @param shouldDeletePromAlarm - boolean flag to indicate if prometheus rules should be deleted.
 * @param prometheusWorkspaceId - The prometheus workspace id.
 * @param ec2AlarmManagerArray - Array of EC2 instances with state and tags.
 * @param service - The service name.
 */

export async function batchPromRulesDeletion(
  prometheusWorkspaceId: string,
  ec2AlarmManagerArray: EC2AlarmManagerArray,
  service: string,
) {
  log
    .info()
    .str('function', 'batchPromRulesDeletion')
    .msg('Prometheus rules have been marked for deletion. Fetching instances.');

  try {
    // Using the passed EC2AlarmManagerArray instead of fetching instances
    const instancesToDelete = ec2AlarmManagerArray
      .filter((details) => {
        const baseCondition =
          details.tags['autoalarm:target'] === 'cloudwatch' ||
          details.tags['autoalarm:enabled'] === 'false';
        const isTerminating = ['terminated'].includes(details.state);

        return (
          baseCondition || (details.tags['autoalarm:enabled'] && isTerminating)
        );
      })
      .map((details) => details.instanceID);

    log
      .info()
      .str('function', 'batchPromRulesDeletion')
      .str('instancesToDelete', JSON.stringify(instancesToDelete))
      .msg('Instances to delete Prometheus rules for');

    if (instancesToDelete.length > 0) {
      // Delete Prometheus rules for all relevant instances at once
      await deletePromRulesForService(
        prometheusWorkspaceId,
        service,
        instancesToDelete,
      );
      log
        .info()
        .str('function', 'batchPromRulesDeletion')
        .msg(
          'Prometheus rules deleted successfully in batch or no rules to delete',
        );
    } else {
      log
        .info()
        .str('function', 'batchPromRulesDeletion')
        .msg('No instances found to delete Prometheus rules for');
    }
  } catch (error) {
    log
      .error()
      .str('function', 'batchPromRulesDeletion')
      .err(error)
      .msg('Error deleting Prometheus rules.');
  }
}

/**
 * Get alarm configurations for prometheus alarms. Specifically, for an instance based on its tags and classification.
 * @param instanceId - The EC2 instance ID.
 * @param classification - The alarm classification (e.g., CRITICAL, WARNING).
 * @returns Array of alarm configurations.
 * TODO: We are going to need to adjust this function to have a simlar flow  as the manageActiveEC2Alarms function to
 *  loop through configs and tags to get alarm theshold values or create alarms.
 *  - We are going to need to create a alarms to keep set and use that do delete the other alrms for these instances.
 *    an example can be found in the manageActiveEC2Alarms and handleAlarmCreation functions.
 *
 */
async function getPromAlarmConfigs(
  instanceId: string,
  classification: AlarmClassification,
  tags: Tag,
  // TODO Fix the use of any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const configs = [];
  const {
    staticThresholdAlarmName: cpuAlarmName,
    threshold: cpuThreshold,
    durationStaticTime: cpuDurationTime,
    ec2Metadata: {platform, privateIp}, //this comes from getInstanceDetails in ec2-modules
    //@ts-expect-error temp for refactor
  } = await getAlarmConfig(instanceId, classification, 'cpu', tags);
  let escapedPrivateIp = '';

  log
    .info()
    .str('function', 'getPromAlarmConfigs')
    .str('instanceId', instanceId)
    .str('classification', classification)
    .str('alarmName', cpuAlarmName)
    .num('threshold', cpuThreshold)
    .num('durationTime', cpuDurationTime)
    .str('platform', platform as string)
    .str('privateIp', privateIp as string)
    .msg('Fetched alarm configuration');

  if (privateIp === '' || privateIp === null) {
    log
      .error()
      .str('function', 'getPromAlarmConfigs')
      .str('instanceId', instanceId)
      .msg('Private IP address not found for instance');
    throw new Error('Private IP address not found for instance');
  } else {
    escapedPrivateIp = privateIp.replace(/\./g, '\\\\.');
  }

  const cpuQuery = platform?.toLowerCase().includes('windows')
    ? `100 - (rate(windows_cpu_time_total{instance=~"(${escapedPrivateIp}.*|${instanceId})", mode="idle"}[30s]) * 100) > ${cpuThreshold}`
    : `100 - (rate(node_cpu_seconds_total{mode="idle", instance=~"(${escapedPrivateIp}.*|${instanceId})"}[30s]) * 100) > ${cpuThreshold}`;

  configs.push({
    instanceId,
    type: classification,
    alarmName: cpuAlarmName,
    alarmQuery: cpuQuery,
    duration: `${Math.floor(cpuDurationTime / 60)}m`, // Ensuring whole numbers for duration
    severityType: classification.toLowerCase(),
  });

  const {
    staticThresholdAlarmName: memAlarmName,
    threshold: memThreshold,
    durationStaticTime: memDurationTime,
    //@ts-expect-error temp for refactor
  } = await getAlarmConfig(instanceId, classification, 'memory', tags);

  log
    .info()
    .str('function', 'getPromAlarmConfigs')
    .str('instanceId', instanceId)
    .str('classification', classification)
    .str('alarmName', memAlarmName)
    .num('threshold', memThreshold)
    .num('durationTime', memDurationTime)
    .str('platform', platform as string)
    .str('privateIp', privateIp as string)
    .msg('Fetched alarm configuration');

  const memQuery = platform?.toLowerCase().includes('windows')
    ? `100 - ((windows_os_virtual_memory_free_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})",job="ec2"} / windows_os_virtual_memory_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})",job="ec2"}) * 100) > ${memThreshold}`
    : `100 - ((node_memory_MemAvailable_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"} / node_memory_MemTotal_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"}) * 100) > ${memThreshold}`;

  configs.push({
    instanceId,
    type: classification,
    alarmName: memAlarmName,
    alarmQuery: memQuery,
    duration: `${Math.floor(memDurationTime / 60)}m`, // Ensuring whole numbers for duration
    severityType: classification.toLowerCase(),
  });

  const {
    staticThresholdAlarmName: storageAlarmName,
    threshold: storageThreshold,
    durationStaticTime: storageDurationTime,
    //@ts-expect-error temp for refactor
  } = await getAlarmConfig(instanceId, classification, 'storage', tags);

  log
    .info()
    .str('function', 'getPromAlarmConfigs')
    .str('instanceId', instanceId)
    .str('classification', classification)
    .str('alarmName', storageAlarmName)
    .num('threshold', storageThreshold)
    .num('durationTime', storageDurationTime)
    .str('platform', platform as string)
    .str('privateIp', privateIp as string)
    .msg('Fetched alarm configuration');

  const storageQuery = platform?.toLowerCase().includes('windows')
    ? `100 - ((windows_logical_disk_free_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"} / windows_logical_disk_size_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"}) * 100) > ${storageThreshold}`
    : `100 - ((node_filesystem_free_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"} / node_filesystem_size_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"}) * 100) > ${storageThreshold}`;

  configs.push({
    instanceId,
    type: classification,
    alarmName: storageAlarmName,
    alarmQuery: storageQuery,
    duration: `${Math.floor(storageDurationTime / 60)}m`, // Ensuring whole numbers for duration
    severityType: classification.toLowerCase(),
  });

  return configs;
}

/**
 * Batch update Prometheus rules for all EC2 instances with the necessary tags and metrics reporting.
 * @param shouldUpdatePromRules - Boolean flag to indicate if Prometheus rules should be updated.
 * @param prometheusWorkspaceId - The Prometheus workspace ID.
 * @param service - The service name.
 * @param region - The AWS region passed by an environment variable.
 * @param ec2AlarmManagerArray - Array of EC2 instances with state and tags.
 */
export async function batchUpdatePromRules(
  prometheusWorkspaceId: string,
  service: string,
  ec2AlarmManagerArray: EC2AlarmManagerArray,
  region: string,
) {
  log
    .info()
    .str('function', 'batchUpdatePromRules')
    .msg('Fetching instance details and tags');

  try {
    log
      .info()
      .str('function', 'batchUpdatePromRules')
      .msg('Filtering instances based on tags');

    // Filter instances based on the 'autoalarm:enabled' tag in EC2AlarmManagerArray
    const instancesToCheck = ec2AlarmManagerArray.filter(
      (details) =>
        details.tags['autoalarm:enabled'] &&
        details.tags['autoalarm:enabled'] !== 'false',
    );

    if (instancesToCheck.length === 0) {
      log
        .error()
        .str('function', 'batchUpdatePromRules')
        .str('instancesToCheck', JSON.stringify(instancesToCheck))
        .msg(
          'No instances found with autoalarm:enabled tag set to true. Verify BatchUpdatePromRules logic and manageActiveEC2Alarms function.',
        );
      throw new Error(
        'No instances found with autoalarm:enabled tag set to true. Verify BatchUpdatePromRules logic and manageActiveEC2Alarms function.',
      );
    }

    log
      .info()
      .str('function', 'batchUpdatePromRules')
      .str('instancesToCheck', JSON.stringify(instancesToCheck))
      .msg('Instances to check for Prometheus rules');

    // Query Prometheus to get a list of instance label values (private IPs or Instance IDs)
    const reportingInstances = await queryPrometheusForService(
      'ec2',
      prometheusWorkspaceId,
      region,
    );

    const instancesToUpdate = instancesToCheck.filter((details) =>
      reportingInstances.includes(details.instanceID),
    );

    if (instancesToUpdate.length === 0) {
      log
        .error()
        .str('function', 'batchUpdatePromRules')
        .str('instancesToUpdate', JSON.stringify(instancesToUpdate))
        .msg('No instances found to update Prometheus rules for');
      return;
    }

    log
      .info()
      .str('function', 'batchUpdatePromRules')
      .str('instancesToUpdate', JSON.stringify(instancesToUpdate))
      .msg('Instances to update Prometheus rules for');

    // TODO Fix the use of any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alarmConfigs: any[] = [];
    for (const {instanceID} of instancesToUpdate) {
      for (const classification of Object.values(AlarmClassification)) {
        const configs = await getPromAlarmConfigs(
          instanceID,
          classification,
          ec2AlarmManagerArray.find((i) => i.instanceID === instanceID)?.tags ||
            {},
        );
        alarmConfigs.push(...configs);
      }
    }

    log
      .info()
      .str('function', 'batchUpdatePromRules')
      .str('alarmConfigs', JSON.stringify(alarmConfigs))
      .msg('Consolidated alarm configurations');

    const namespace = `AutoAlarm-${service.toUpperCase()}`;
    const ruleGroupName = 'AutoAlarm';

    log
      .info()
      .str('function', 'batchUpdatePromRules')
      .msg(
        `Updating Prometheus rules for all instances in batch under namespace: ${namespace}`,
      );

    await managePromNamespaceAlarms(
      prometheusWorkspaceId,
      namespace,
      ruleGroupName,
      alarmConfigs,
    );

    log
      .info()
      .str('function', 'batchUpdatePromRules')
      .msg('Batch update of Prometheus rules completed.');
  } catch (error) {
    log
      .error()
      .str('function', 'batchUpdatePromRules')
      .err(error)
      .msg('Error during batch update of Prometheus rules');
    throw new Error(`Error during batch update of Prometheus rules: ${error}`);
  }
}

// We use the following const to make a signed http request for the prom APIs following patterns found in this example:
// https://github.com/aws-samples/sigv4-signing-examples/blob/main/sdk/nodejs/main.js. We use defaultProvider to get the
// credentials needed to sign the request. We then sign the request using aws4 and make the request using https.request.
export const makeSignedRequest = async (
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

/**
 * This function uses case switching to dynamically check that aws managed prometheus is receiving data from a service.
 * cases are ec2, ecs, eks, rds, etc <--- add more cases as needed and make note here in this comment. All Lower case.
 * ec2 service identifier is the instance private IP address.
 * ecs service identifier is...
 * eks service identifier is...
 * rds service identifier is...
 * QueryMetrics API documentation can be found here: https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-APIReference-QueryMetrics.html
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

        const instances: string[] = [];

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
            instances.push(ip);
            // Log the matched IP address
            log
              .info()
              .str('function', 'queryPrometheusForService')
              .str('ip', ip)
              .msg('Matched IP address');
          } else if (ec2InstanceIdRegex.test(instance)) {
            instances.push(instance);
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

        return instances;
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

/**
 * Function to delete Prometheus rules for a service.
 * @param promWorkspaceId - The Prometheus workspace ID.
 * @param service - The service name.
 * @param serviceIdentifiers - The service identifiers.
 */
export async function deletePromRulesForService(
  promWorkspaceId: string,
  service: string,
  serviceIdentifiers: string[],
): Promise<void> {
  const namespace = `AutoAlarm-${service.toUpperCase()}`;
  const ruleGroupName = 'AutoAlarm';

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
      .error()
      .str('function', 'deletePromRulesForService')
      .obj('error', error as object)
      .msg('Error deleting Prometheus rules.');
    throw new Error(`Failed to delete Prometheus rules: ${error}`);
  }
}
