import {ExtendedNodejsFunction} from 'truemark-cdk-lib/aws-lambda';
import {IRole} from 'aws-cdk-lib/aws-iam';
import {Construct} from 'constructs';
import * as path from 'path';
import {Duration} from 'aws-cdk-lib';
import {Architecture} from 'aws-cdk-lib/aws-lambda';
import * as process from 'process';

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
        'main-handler.ts'
      ),
      architecture: Architecture.ARM_64,
      handler: 'handler',
      timeout: Duration.seconds(300),
      memorySize: 768,
      role: props?.role,
      environment: {
        PROMETHEUS_WORKSPACE_ID: props?.prometheusWorkspaceId || '',
      },
    });
  }
}
