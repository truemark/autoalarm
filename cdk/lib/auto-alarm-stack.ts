import {Construct} from 'constructs';
import {AutoAlarmConstruct} from './auto-alarm-construct';
import {ExtendedStack, ExtendedStackProps} from 'truemark-cdk-lib/aws-cdk';
import {CronOptions} from 'aws-cdk-lib/aws-events';
import {version} from '../../package.json';

export interface ExtendedAutoAlarmProps extends ExtendedStackProps {
  readonly prometheusWorkspaceId?: string;
  readonly useReAlarm?: boolean;
  readonly reAlarmSchedule?: CronOptions;
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
    this.outputParameter('Version', version);
    if (props.prometheusWorkspaceId) {
      this.outputParameter(
        'prometheusWorkspaceId',
        props.prometheusWorkspaceId,
      );
    }
    if (props.useReAlarm) {
      this.outputParameter('useReAlarm', props.useReAlarm ? 'true' : 'false');
    }
    if (props.reAlarmSchedule) {
      this.outputParameter(
        'reAlarmSchedule',
        JSON.stringify(props.reAlarmSchedule),
      );
    }
  }
}
