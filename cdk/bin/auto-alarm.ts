#!/usr/bin/env node
import 'source-map-support/register';

import { AutoAlarmStack } from '../lib/auto-alarm-stack';
import {ExtendedApp} from 'truemark-cdk-lib/aws-cdk';

const app = new ExtendedApp({
  standardTags: {
    automationTags: {
      id: 'autoalarm',
      url: 'https://github.com/truemark/autoalarm',
    }
  }
});

new AutoAlarmStack(app, 'AutoAlarm', {

});
