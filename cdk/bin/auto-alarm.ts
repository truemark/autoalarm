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
// The useReAlarm const is configured to take in an environment variable for the useReAlarm boolean which is then passed
// to the constructs to determine if reAlarm should be configured or not.
const useReAlarmContext = app.node.tryGetContext('useReAlarm');
// The reAlarmSchedule const is configured to take in an environment variable for the reAlarmSchedule cron expression
// which is used to define the schedule for each trigger of ReAlarm.
// Example: {hour: '*/2'} will trigger the function every two hours
// cdk deploy --context reAlarmSchedule='{"hour":"*/2","minute":"0"}' AutoAlarm
const reAlarmScheduleContext = app.node.tryGetContext('reAlarmSchedule');

// Ensure useReAlarm is set to a boolean, default to `false` only if it's undefined (not when false is passed)
const useReAlarm =
  useReAlarmContext !== undefined ? useReAlarmContext === 'true' : false;

// Safely parse the reAlarmSchedule context variable if it exists. If not, default to every two hours.
const reAlarmSchedule = reAlarmScheduleContext
  ? JSON.parse(reAlarmScheduleContext)
  : {hour: '*/2', minute: '0'}; // Fallback to default schedule

new AutoAlarmStack(app, 'AutoAlarm', {
  version: version.toString(),
  prometheusWorkspaceId: prometheusWorkspaceId,
  useReAlarm: useReAlarm,
  reAlarmSchedule: reAlarmSchedule,
});
