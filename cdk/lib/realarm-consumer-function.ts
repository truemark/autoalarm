import {ExtendedNodejsFunction} from 'truemark-cdk-lib/aws-lambda';
import {IRole} from 'aws-cdk-lib/aws-iam';
import {Construct} from 'constructs';
import * as path from 'path';
import {Duration} from 'aws-cdk-lib';
import {Architecture} from 'aws-cdk-lib/aws-lambda';

interface ReAlarmConsumerFunctionProps {
  role?: IRole; // Define other props as needed
}

export class ReAlarmConsumerFunction extends ExtendedNodejsFunction {
  public readonly reAlarmConsumerFunctionArn: string;
  constructor(
    scope: Construct,
    id: string,
    props?: ReAlarmConsumerFunctionProps,
  ) {
    super(scope, id, {
      entry: path.join(
        __dirname,
        '..',
        '..',
        'handlers',
        'src',
        'realarm-consumer-handler.mts',
      ),
      architecture: Architecture.ARM_64,
      handler: 'handler',
      timeout: Duration.minutes(15),
      memorySize: 768,
      role: props?.role,
      deploymentOptions: {
        createDeployment: false,
      },
      bundling: {
        nodeModules: ['@smithy/util-retry'],
      },
    });
    // Expose the function ARN
    this.reAlarmConsumerFunctionArn = this.functionArn;
  }
}
