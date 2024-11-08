import {ExtendedNodejsFunction} from 'truemark-cdk-lib/aws-lambda';
import {IRole} from 'aws-cdk-lib/aws-iam';
import {Construct} from 'constructs';
import * as path from 'path';
import {Duration} from 'aws-cdk-lib';
import {Architecture} from 'aws-cdk-lib/aws-lambda';

interface ReAlarmFunctionProps {
  role?: IRole; // Define other props as needed
}

export class ReAlarmFunction extends ExtendedNodejsFunction {
  constructor(scope: Construct, id: string, props?: ReAlarmFunctionProps) {
    super(scope, id, {
      entry: path.join(
        __dirname,
        '..',
        '..',
        'handlers',
        'src',
        'realarm-handler.mts'
      ),
      architecture: Architecture.ARM_64,
      handler: 'handler',
      timeout: Duration.minutes(5),
      memorySize: 768,
      role: props?.role,
      deploymentOptions: {
        createDeployment: false,
      },
    });
  }
}
