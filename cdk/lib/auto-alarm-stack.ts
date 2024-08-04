import {Construct} from 'constructs';
import {AutoAlarmConstruct} from './auto-alarm-construct';
import {ExtendedStack, ExtendedStackProps} from 'truemark-cdk-lib/aws-cdk';
import {version} from 'esbuild';

export interface ExtendedAutoAlarmProps extends ExtendedStackProps {
  version: string;
  prometheusWorkspaceId?: string;
}

export class AutoAlarmStack extends ExtendedStack {
  constructor(scope: Construct, id: string, props: ExtendedAutoAlarmProps) {
    // Use the extended interface here
    super(scope, id, props);
    new AutoAlarmConstruct(this, 'AutoAlarm', {
      prometheusWorkspaceId: props.prometheusWorkspaceId,
    });
    this.outputParameter('Name', 'AutoAlarm');
    this.outputParameter('Version', version);
  }
}
