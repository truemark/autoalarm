#!/usr/bin/env node
import 'source-map-support/register';
import {AutoAlarmStack} from '../lib/auto-alarm-stack';
import {ExtendedApp} from 'truemark-cdk-lib/aws-cdk';

const app = new ExtendedApp({
  standardTags: {
    automationTags: {
      id: 'autoalarm',
      url: 'https://github.com/truemark/autoalarm',
    },
  },
});

// The prometheusWorkspaceId const is configured to take in an environment variable for the Prometheus Workspace ID which
// is then passed to our lambda to use dynamically across all environments.
const prometheusWorkspaceId = app.node.tryGetContext('prometheusWorkspaceId');
// The enableReAlarm const is configured to take in an environment variable for the enableReAlarm boolean which is then passed
// to the constructs to determine if reAlarm should be configured or not.
const useReAlarmContext = app.node.tryGetContext('EnableReAlarm');
// Ensure enableReAlarm is set to a boolean, default to `true` if not set.
const useReAlarm =
  useReAlarmContext !== undefined ? useReAlarmContext === 'true' : true;

// OAM Sink configuration
const enableOamSink = app.node.tryGetContext('EnableOamSink') === 'true';
const oamSourceAccountIds = app.node
  .tryGetContext('OamSourceAccountIds')
  ?.split(',')
  .filter(Boolean);
const oamOrganizationIds = app.node
  .tryGetContext('OamOrganizationIds')
  ?.split(',')
  .filter(Boolean);

// Enrichment pipeline configuration
const enableEnrichment = app.node.tryGetContext('EnableEnrichment') === 'true';
const enrichmentSourceAccountIds = app.node
  .tryGetContext('EnrichmentSourceAccountIds')
  ?.split(',')
  .filter(Boolean);
const enrichmentOrganizationIds = app.node
  .tryGetContext('EnrichmentOrganizationIds')
  ?.split(',')
  .filter(Boolean);
const enableAgentEnrichment =
  app.node.tryGetContext('EnableAgentEnrichment') === 'true';
const agentRuntimeArn = app.node.tryGetContext('AgentRuntimeArn');
const agentSeverityFilterContext = app.node.tryGetContext(
  'AgentSeverityFilter',
);
const agentSeverityFilter = agentSeverityFilterContext
  ? agentSeverityFilterContext.split(',').filter(Boolean)
  : ['Critical'];

// Source account StackSet configuration
const enableSourceAccountStackSet =
  app.node.tryGetContext('EnableSourceAccountStackSet') === 'true';
const stackSetTargetOuIds = app.node
  .tryGetContext('StackSetTargetOuIds')
  ?.split(',')
  .filter(Boolean);
const stackSetDeploymentRegions = app.node
  .tryGetContext('StackSetDeploymentRegions')
  ?.split(',')
  .filter(Boolean);
const stackSetLogGroupFilter = app.node.tryGetContext('StackSetLogGroupFilter');
const stackSetPermissionModelCtx = app.node.tryGetContext(
  'StackSetPermissionModel',
);
const stackSetPermissionModel: 'SERVICE_MANAGED' | 'SELF_MANAGED' | undefined =
  stackSetPermissionModelCtx === 'SELF_MANAGED'
    ? 'SELF_MANAGED'
    : stackSetPermissionModelCtx === 'SERVICE_MANAGED'
      ? 'SERVICE_MANAGED'
      : undefined;

new AutoAlarmStack(app, 'AutoAlarm', {
  prometheusWorkspaceId: prometheusWorkspaceId,
  enableReAlarm: useReAlarm,
  enableOamSink,
  oamSourceAccountIds,
  oamOrganizationIds,
  enableEnrichment,
  enrichmentSourceAccountIds,
  enrichmentOrganizationIds,
  enableAgentEnrichment,
  agentRuntimeArn,
  agentSeverityFilter,
  enableSourceAccountStackSet,
  stackSetTargetOuIds,
  stackSetDeploymentRegions,
  stackSetLogGroupFilter,
  stackSetPermissionModel,
});
