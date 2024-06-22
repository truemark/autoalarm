#!/usr/bin/env node
import 'source-map-support/register';
import {AutoAlarmStack} from '../lib/auto-alarm-stack';
import {ExtendedApp} from 'truemark-cdk-lib/aws-cdk';
import {ExtendedAutoAlarmProps} from '../lib/auto-alarm-stack-props';

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
const stackProps: ExtendedAutoAlarmProps = {
  prometheusWorkspaceId: prometheusWorkspaceId,
};

new AutoAlarmStack(app, 'AutoAlarm', stackProps);

