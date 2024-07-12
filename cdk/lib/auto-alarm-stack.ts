import {Construct} from 'constructs';
import {AutoAlarmConstruct} from './auto-alarm-construct';
import {ExtendedStack} from 'truemark-cdk-lib/aws-cdk';
import {ExtendedAutoAlarmProps} from './auto-alarm-stack-props'; // Import the extended interface

export class AutoAlarmStack extends ExtendedStack {
  constructor(
    scope: Construct,
    id: string,
    props: ExtendedAutoAlarmProps
  ) {
    // Use the extended interface here
    super(scope, id, props);
    new AutoAlarmConstruct(this, 'AutoAlarm', {
      prometheusWorkspaceId: props.prometheusWorkspaceId,
    });
    this.outputParameter('Name', 'AutoAlarm');
    this.outputParameter('Version', '1.1.0');
  }
}
