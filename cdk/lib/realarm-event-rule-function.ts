import {ExtendedNodejsFunction} from 'truemark-cdk-lib/aws-lambda';
import {IRole} from 'aws-cdk-lib/aws-iam';
import {Construct} from 'constructs';
import * as path from 'path';
import {Duration} from 'aws-cdk-lib';
import {Architecture} from 'aws-cdk-lib/aws-lambda';

interface ReAlarmEventRuleFunctionProps {
  role: IRole; // Define other props as needed
  targertQueueArn: string;
}

export class ReAlarmEventRuleFunction extends ExtendedNodejsFunction{
  constructor(
    scope: Construct,
    id: string,
    props: ReAlarmEventRuleFunctionProps,
  ) {
    super(scope, id, {
      entry: path.join(
        __dirname,
        '..',
        '..',
        'handlers',
        'src',
        'realarm-event-rule-handler.mts',
      ),
      architecture: Architecture.ARM_64,
      handler: 'handler',
      timeout: Duration.minutes(15),
      memorySize: 768,
      role: props.role,
      environment: {
        TARGET_SQS_QUEUE_ARN: props.targertQueueArn,
      },
      deploymentOptions: {
        createDeployment: false,
      },
    });
  }
}
