import {ExtendedNodejsFunction} from 'truemark-cdk-lib/aws-lambda';
import {IRole} from 'aws-cdk-lib/aws-iam';
import {Construct} from 'constructs';
import * as path from 'path';
import {Duration} from 'aws-cdk-lib';
import {Architecture} from 'aws-cdk-lib/aws-lambda';

interface ReAlarmProducerFunctionProps {
  role?: IRole; // Define other props as needed
}

export class RealarmProducerFunction extends ExtendedNodejsFunction {
  public readonly reAlarmProducerFunctionArn: string;
  constructor(
    scope: Construct,
    id: string,
    props?: ReAlarmProducerFunctionProps,
  ) {
    super(scope, id, {
      entry: path.join(
        __dirname,
        '..',
        '..',
        'handlers',
        'src',
        'realarm-producer-handler.mts',
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
    this.reAlarmProducerFunctionArn = this.functionArn;
  }
}
