#!/usr/bin/env node
import 'source-map-support/register';
import {AutoAlarmStack} from '../lib/auto-alarm-stack';
import {ExtendedApp} from 'truemark-cdk-lib/aws-cdk';
import {version} from '../../package.json';

const app = new ExtendedApp({
  standardTags: {
    automationTags: {
      id: 'autoalarm',
      url: 'https://github.com/truemark/autoalarm',
    },
    teamTags: {
      name: 'TrueMark EOC',
      id: 'truemark-eoc',
    },
  },
});

// The prometheusWorkspaceId const is configured to take in an environment variable for the Prometheus Workspace ID which
// is then passed to our lambda to use dynamically across all environments.
const prometheusWorkspaceId = app.node.tryGetContext('prometheusWorkspaceId');
const useReAlarm = app.node.tryGetContext('useReAlarm');

new AutoAlarmStack(app, 'AutoAlarm', {
  version: version.toString(),
  prometheusWorkspaceId: prometheusWorkspaceId,
  useReAlarm: useReAlarm,
});
