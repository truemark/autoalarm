import {Construct} from 'constructs';
import {MainFunction} from './main-function';
import {StandardQueue} from 'truemark-cdk-lib/aws-sqs';
import {Rule} from 'aws-cdk-lib/aws-events';
import {LambdaFunction} from 'aws-cdk-lib/aws-events-targets';
import {ExtendedAutoAlarmProps} from './auto-alarm-stack-props';
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  Effect,
} from 'aws-cdk-lib/aws-iam';
import {Stack} from 'aws-cdk-lib';

export class AutoAlarmConstruct extends Construct {
  constructor(scope: Construct, id: string, props: ExtendedAutoAlarmProps) {
    super(scope, id);

    //the following four consts are used to pass the correct ARN for whichever prometheus ID is being used as well as to the lambda.
    const prometheusWorkspaceId = props.prometheusWorkspaceId || '';
    const accountId = Stack.of(this).account;
    const region = Stack.of(this).region;
    const prometheusArn = `arn:aws:aps:${region}:${accountId}:workspace/${prometheusWorkspaceId}`;

    // Define the IAM role with specific permissions for the Lambda function
    const lambdaExecutionRole = new Role(this, 'LambdaExecutionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for AutoAlarm Lambda function',
    });

    // Attach policies for Prometheus
    lambdaExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'aps:QueryMetrics',
          'aps:ListRuleGroupsNamespaces',
          'aps:DescribeRuleGroupsNamespace',
          'aps:CreateRuleGroupsNamespace',
          'aps:PutRuleGroupsNamespace',
        ],
        resources: [
          prometheusArn,
          `arn:aws:aps:${region}:${accountId}:*/${prometheusWorkspaceId}/*`,
        ],
      })
    );

    // Attach policies for EC2 and CloudWatch
    lambdaExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'ec2:DescribeInstances',
          'ec2:DescribeTags',
          'cloudwatch:PutMetricAlarm',
          'cloudwatch:DeleteAlarms',
          'cloudwatch:DescribeAlarms',
          'cloudwatch:ListMetrics',
        ],
        resources: ['*'],
      })
    );

    // Attach policies for CloudWatch Logs
    lambdaExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: ['*'],
      })
    );

    // Create the MainFunction and explicitly pass the execution role
    const mainFunction = new MainFunction(this, 'MainFunction', {
      role: lambdaExecutionRole, // Pass the role here
      prometheusWorkspaceId: prometheusWorkspaceId,
    });

    const deadLetterQueue = new StandardQueue(this, 'DeadLetterQueue');
    const mainTarget = new LambdaFunction(mainFunction, {
      deadLetterQueue,
    });

    // Listen to tag changes related to AutoAlarm
    const tagRule = new Rule(this, 'TagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['ec2', 'ecs', 'rds'],
          'resource-type': ['instance'],
          'changed-tag-keys': [
            'autoalarm:disabled',
            'autoalarm:cpu-percent-above-critical',
            'autoalarm:cpu-percent-above-warning',
            'autoalarm:cpu-percent-duration-time',
            'autoalarm:cpu-percent-duration-periods',
            'autoalarm:storage-used-percent-critical',
            'autoalarm:storage-used-percent-warning',
            'autoalarm:storage-percent-duration-time',
            'autoalarm:storage-percent-duration-periods',
            'autoalarm:memory-percent-above-critical',
            'autoalarm:memory-percent-above-warning',
            'autoalarm:memory-percent-duration-time',
            'autoalarm:memory-percent-duration-periods',
            'autoalarm:selective-storage', //true or false
            'Prometheus',
          ],
        },
      },
      description: 'Routes tag events to AutoAlarm',
    });
    tagRule.addTarget(mainTarget);

    const ec2Rule = new Rule(this, 'Ec2Rule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: {
          state: [
            'running',
            'terminated',
            'stopped', //to be removed. for testing only
            'shutting-down', //to be removed. for testing only
            'pending',
          ],
        },
      },
      description: 'Routes ec2 instance events to AutoAlarm',
    });
    ec2Rule.addTarget(mainTarget);
  }
}
