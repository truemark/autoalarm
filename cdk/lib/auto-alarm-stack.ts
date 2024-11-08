import {Construct} from 'constructs';
import {AutoAlarmConstruct} from './auto-alarm-construct';
import {ExtendedStack, ExtendedStackProps} from 'truemark-cdk-lib/aws-cdk';
import {CronOptions} from 'aws-cdk-lib/aws-events';

export interface ExtendedAutoAlarmProps extends ExtendedStackProps {
  version: string;
  prometheusWorkspaceId?: string;
  useReAlarm?: boolean;
  reAlarmSchedule?: CronOptions;
}

export class AutoAlarmStack extends ExtendedStack {
  constructor(scope: Construct, id: string, props: ExtendedAutoAlarmProps) {
    // Use the extended interface here
    super(scope, id, props);
    new AutoAlarmConstruct(this, 'AutoAlarm', {
      prometheusWorkspaceId: props.prometheusWorkspaceId,
      useReAlarm: props.useReAlarm,
      reAlarmSchedule: props.reAlarmSchedule,
    });
    this.outputParameter('Name', 'AutoAlarm');
    this.outputParameter('Version', props.version);
  }
}
