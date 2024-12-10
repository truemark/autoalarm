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

new AutoAlarmStack(app, 'AutoAlarm', {
  prometheusWorkspaceId: prometheusWorkspaceId,
  enableReAlarm: useReAlarm,
});
