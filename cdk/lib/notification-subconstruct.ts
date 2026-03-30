import {ExtendedNodejsFunction} from 'truemark-cdk-lib/aws-lambda';
import {
  Effect,
  IRole,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import {Construct} from 'constructs';
import * as path from 'path';
import {ArnFormat, Duration, Stack} from 'aws-cdk-lib';
import {Architecture} from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export interface NotificationProps {
  readonly slackWebhookSsmPath: string;
  readonly runbookUrl?: string;
}

export class NotificationSubConstruct extends Construct {
  public readonly lambdaFunction: ExtendedNodejsFunction;

  constructor(scope: Construct, id: string, props: NotificationProps) {
    super(scope, id);

    const role = this.createRole(props.slackWebhookSsmPath);
    this.lambdaFunction = this.createFunction(role, props);
    this.createEventRule();
  }

  private createRole(ssmPath: string): IRole {
    const role = new Role(this, 'NotificationRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for AutoAlarm Notification Lambda function',
    });

    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: ['*'],
      }),
    );

    // Scoped to the specific SSM parameter
    const ssmParamArn = Stack.of(this).formatArn({
      service: 'ssm',
      resource: 'parameter',
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      resourceName: ssmPath.replace(/^\//, ''),
    });

    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [ssmParamArn],
      }),
    );

    // Required for decrypting SecureString SSM parameters
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['kms:Decrypt'],
        resources: ['*'],
      }),
    );

    // CloudWatch read access for enrichment (tags, related alarms, metric data)
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'cloudwatch:DescribeAlarms',
          'cloudwatch:GetMetricData',
          'cloudwatch:ListTagsForResource',
        ],
        resources: ['*'],
      }),
    );

    // CloudTrail read access for recent changes
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['cloudtrail:LookupEvents'],
        resources: ['*'],
      }),
    );

    return role;
  }

  private createFunction(
    role: IRole,
    props: NotificationProps,
  ): ExtendedNodejsFunction {
    const environment: Record<string, string> = {
      SLACK_WEBHOOK_SSM_PATH: props.slackWebhookSsmPath,
    };
    if (props.runbookUrl) {
      environment.RUNBOOK_URL = props.runbookUrl;
    }

    return new ExtendedNodejsFunction(this, 'NotificationFunction', {
      entry: path.join(
        __dirname,
        '..',
        '..',
        'handlers',
        'src',
        'notification-handler.mts',
      ),
      architecture: Architecture.ARM_64,
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 256,
      role: role,
      environment,
      deploymentOptions: {
        createDeployment: false,
      },
      bundling: {
        nodeModules: ['@smithy/util-retry'],
      },
    });
  }

  private createEventRule(): void {
    const rule = new events.Rule(this, 'AlarmStateChangeRule', {
      description: 'Routes AutoAlarm state changes to the notification Lambda',
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        detail: {
          alarmName: [{prefix: 'AutoAlarm-'}],
          state: {
            value: ['ALARM', 'OK'],
          },
        },
      },
    });

    rule.addTarget(new targets.LambdaFunction(this.lambdaFunction));
  }
}
