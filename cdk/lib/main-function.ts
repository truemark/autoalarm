import {ExtendedNodejsFunction} from 'truemark-cdk-lib/aws-lambda';
import {IRole} from 'aws-cdk-lib/aws-iam';
import {Construct} from 'constructs';
import * as path from 'path';
import {Duration} from 'aws-cdk-lib';
import {Architecture} from 'aws-cdk-lib/aws-lambda';

interface MainFunctionProps {
  role?: IRole; // Define other props as needed
  prometheusWorkspaceId?: string;
}

export class MainFunction extends ExtendedNodejsFunction {
  constructor(scope: Construct, id: string, props?: MainFunctionProps) {
    super(scope, id, {
      entry: path.join(
        __dirname,
        '..',
        '..',
        'handlers',
        'src',
        'main-handler.mts',
      ),
      architecture: Architecture.ARM_64,
      handler: 'handler',
      timeout: Duration.minutes(15),
      memorySize: 768,
      role: props?.role,
      environment: {
        PROMETHEUS_WORKSPACE_ID: props?.prometheusWorkspaceId || '',
      },
      deploymentOptions: {
        createDeployment: false,
      },
    });
  }
}
