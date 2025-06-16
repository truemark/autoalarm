/**
 * this is a temp file to hold some/partially refactored prometheus logic in order to integrate
 * with AutoAlarms DB Prometheus logic. The old logic was centered around EC2 and therefore
 * was not flexible enough to be used for other services. This file will be refactored and moved
 */

import * as logging from '@nr1e/logging';
import {
  AmpClient,
  DeleteRuleGroupsNamespaceCommand,
  DescribeRuleGroupsNamespaceCommand,
  DescribeRuleGroupsNamespaceCommandOutput,
  ListRuleGroupsNamespacesCommand,
  PutRuleGroupsNamespaceCommand,
} from '@aws-sdk/client-amp';
import {buildAlarmName, describeNamespace} from './index.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import {defaultProvider} from '@aws-sdk/credential-provider-node';
import {
  createNamespace,
  isNamespaceDetails,
  verifyPromWorkspace,
} from './prometheus-tools.mjs';
import * as yaml from 'js-yaml';
import {
  AlarmClassification, AlarmUpdateResult,
  AMPRule, MetricAlarmConfig,
  NamespaceConfig,
  NameSpaceDetails,
  RuleGroup
} from '../../types/index.mjs';

const log: logging.Logger = logging.getLogger('ec2-modules');
const region: string = process.env.AWS_REGION || '';
const client = new AmpClient({
  region,
  credentials: defaultProvider(),
  retryStrategy: new ConfiguredRetryStrategy(
    20,
    (retryAttempt) => retryAttempt ** 2 * 500,
  ),
});

async function nameSpaceExists(
  promWorkspaceId: string,
  updatedConfigs: NameSpaceDetails,
): Promise<boolean> {
  await Promise.all(
    Object.keys(updatedConfigs).map(async (namespace) => {
      try {
        const response = await client.send(
          new ListRuleGroupsNamespacesCommand({workspaceId: promWorkspaceId}),
        );

        if (
          !response.ruleGroupsNamespaces?.some((ns) => ns.name === namespace)
        ) {
          // Create the namespace if it does not exist
          await createNamespace(
            promWorkspaceId,
            namespace,
            updatedConfigs[namespace].groups,
          );
        }
        return true;
      } catch (error) {
        log
          .error()
          .str('function', 'nameSpaceExists')
          .err(error)
          .msg('Failed to list namespaces');
        throw new Error(`Failed to list namespaces: ${error}`);
      }
    }),
  );
  return true;
}

// Describe the namespace to get current details
async function describeNamespaceV2(
  promWorkspaceId: string,
  namespaces: string[],
):Promise<NameSpaceDetails> {
  const namespaceDetails: {[namespace: string]: NamespaceConfig | Uint8Array} = {};

  const command = new DescribeRuleGroupsNamespaceCommand({
    workspaceId: promWorkspaceId,
    name: '',
  });

  await Promise.all(
    namespaces.map(async (namespace) => {
      command.input.name = namespace;
      try {
        const response = await client.send(command);

        // Check if the response contains data for the namespace and add to namespaceDetails if it does.
        if (response.ruleGroupsNamespace?.data) {
          namespaceDetails[namespace] = response.ruleGroupsNamespace.data;
        }

        // We need to decode the Uint8Array to a string and parse it as YAML for all values in our namespaceDetails object
        if (namespaceDetails[namespace] instanceof Uint8Array) {
          const yamlString = new TextDecoder().decode(
            namespaceDetails[namespace],
          );
          namespaceDetails[namespace] = yaml.load(
            yamlString,
          ) as NamespaceConfig;
        }
      } catch (error) {
        log
          .error()
          .str('function', 'describeNamespaceV2')
          .str('namespace', namespace)
          .err(error)
          .msg('Failed to describe namespace');
        throw new Error(`Failed to describe namespace: ${namespace}`);
      }
    }),
  );
  return namespaceDetails as NameSpaceDetails;
}

// Check if ns empty, if it is, create it. Check if <2000 rules.
export async function verifyNamespace(
  namespaces: NameSpaceDetails,
): Promise<void> {
  Object.entries(namespaces).forEach(([K, V]) => {
    if (!isNamespaceDetails(V)) {
      log
        .error()
        .str('function', 'verifyNamespace')
        .str('namespace', K)
        .msg('Invalid or empty namespace details, skipping');
      throw new Error(`Failed to verifyNamespace: ${K}`);
    }

    // Count total rules in the namespace
    const totalRules = V.groups.reduce(
      (count, group) => count + group.rules.length,
      0,
    );

    if (totalRules >= 2000) {
      log
        .error()
        .str('function', 'verifyNamespace')
        .str('namespace', K)
        .msg('The namespace has 2000 or more rules. Halting Prometheus logic.');
      throw new Error(
        'The namespace has 2000 or more rules. Halting and falling back to CW Alarms.',
      );
    }
  });
}

// build AMPRule for a given engine, hostID, config, expression and severity
export function buildAMPRule(
  engine: string,
  hostID: string,
  config: MetricAlarmConfig,
  expr: string,
  severity: 'warning' | 'critical',
): AlarmUpdateResult<{ampRule: AMPRule}> {

  const alertName = buildAlarmName(
    config,
    engine,
    hostID,
    severity === 'warning' ? AlarmClassification.Warning : AlarmClassification.Critical,
    'static',
  );

  const rule: AMPRule = {
    alertName: alertName,
    expr: expr,
    timeSeries: `${config.defaults.period}m`,
    labels: {
      severity: severity.toLowerCase(),
    },
    annotations: {
      summary: `AutoAlarm for ${hostID}. Managed with tag: autoalarm:${config.tagKey}`,
      description: `${severity} monitor for ${hostID}. Monitoring ${config.metricName} for ${config.defaults.period} minutes. Periods`,
    },
  };

  return {
    isSuccess: true,
    res: 'Successfully built AMPRule',
    data: {ampRule: rule},
  };
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
  // TODO Fix the use of any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  alarmConfigs: any[],
) {
  // List all existing namespaces and count total rules
  const namespaces = await listNamespacesV2(promWorkspaceId);
  let totalWSRules = 0;

  // Count total rules across all namespaces
  for (const ns of namespaces) {
    const nsDetails = await describeNamespaceV2(
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
    await createNamespace(promWorkspaceId, namespace, alarmConfigs);
    log
      .info()
      .str('function', 'managePromNamespaceAlarms')
      .str('namespace', namespace)
      .msg(
        'Created new namespace and added rules. Waiting 90 seconds to allow namespace to propagate.',
      );
    await new Promise((resolve) => setTimeout(resolve, 90000)); // Wait for 90 seconds after creating the namespace
    return;
  }

  // Describe the specific namespace to get its details
  const nsDetails = await describeNamespaceV2(promWorkspaceId, namespaces);
  if (!nsDetails || !isNamespaceDetails(nsDetails)) {
    log
      .warn()
      .str('function', 'managePromNamespaceAlarms')
      .str('namespace', namespace)
      .msg('Invalid or empty namespace details, skipping');
    return;
  }

  // Sanity check: if namespace is empty, delete and recreate it
  await Promise.all(Object.entries(nsDetails).map( async ([K, V]) => {
    if (V.groups.length < 1) {
      log
        .warn()
        .str('function', 'managePromNamespaceAlarms')
        .str('namespace', K)
        .msg(
          'Namespace is empty. Deleting and recreating it with updated rules.',
        );

      const deleteNamespaceCommand = new DeleteRuleGroupsNamespaceCommand({
        workspaceId: promWorkspaceId,
        name: K,
      });

      try {
        await client.send(deleteNamespaceCommand);
        await createNamespace(promWorkspaceId, namespace, alarmConfigs);
        return;
      } catch (error) {
        log
          .error()
          .str('function', 'managePromNamespaceAlarms')
          .str('namespace', K)
          .err(error)
          .msg('Failed to delete empty namespace.');
        throw new Error(
          `Failed to delete empty namespace and recreate: ${error}. Function will be unable to proceed.`,
        );
      }
    }
  }));

  // Find the rule group within the namespace or create a new one
  const ruleGroup = nsDetails.groups.find(
    (rg): rg is RuleGroup => rg.name === 'AutoAlarm',
  ) || {name: 'AutoAlarm', rules: []};

  // Iterate over the alarm configurations and update or add rules
  for (const config of alarmConfigs) {
    // Find the index of the existing rule with the same name
    const existingRuleIndex = ruleGroup.rules.findIndex(
      (rule): rule is AMPRule => rule.alertName === config.alarmName,
    );

    if (existingRuleIndex !== -1) {
      // If the rule exists, update its expression if it has changed
      const existingRule = ruleGroup.rules[existingRuleIndex];
      if (
        existingRule.expr !== config.alarmQuery ||
        existingRule.timeSeries !== config.duration
      ) {
        log
          .info()
          .str('function', 'managePromNamespaceAlarms')
          .str('namespace', namespace)
          .str('ruleGroupName', 'AutoAlarm')
          .str('alarmName', config.alarmName)
          .msg(
            'AMPRule exists but expression or duration has changed. Updating the rule.',
          );

        // Update existing rule's expression and duration
        ruleGroup.rules[existingRuleIndex] = {
          ...existingRule,
          expr: config.alarmQuery,
          timeSeries: config.duration,
        };
      } else {
        log
          .info()
          .str('function', 'managePromNamespaceAlarms')
          .str('namespace', namespace)
          .str('ruleGroupName', ruleGroupName)
          .str('alarmName', config.alarmName)
          .msg('AMPRule exists and is identical. No update needed.');
      }
    } else {
      // If the rule does not exist, add a new rule to the rule group
      log
        .info()
        .str('function', 'managePromNamespaceAlarms')
        .str('namespace', namespace)
        .str('ruleGroupName', ruleGroupName)
        .str('alarmName', config.alarmName)
        .msg('AMPRule does not exist. Adding new rule to the rule group.');
      ruleGroup.rules.push({
        alertName: config.alarmName,
        expr: config.alarmQuery,
        timeSeries: config.duration,
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
