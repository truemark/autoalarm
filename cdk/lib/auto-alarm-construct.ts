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
          'aps:DeleteRuleGroupsNamespace',
          'aps:DescribeWorkspace',
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

    // Attach policies for ALB and Target Groups
    lambdaExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'elasticloadbalancing:DescribeLoadBalancers',
          'elasticloadbalancing:DescribeTags',
          'elasticloadbalancing:DescribeTargetGroups',
          'elasticloadbalancing:DescribeTargetHealth',
        ],
        resources: ['*'],
      })
    );

    // Attach policies for SQS
    lambdaExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'sqs:GetQueueAttributes',
          'sqs:GetQueueUrl',
          'sqs:ListQueues',
          'sqs:ListQueueTags',
        ],
        resources: ['*'],
      })
    );

    // Attach policies for OpenSearch
    lambdaExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'es:DescribeElasticsearchDomain',
          'es:ListDomainNames',
          'es:ListTags',
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
    // WARNING threshold num | CRITICAL threshold num | duration time num | duration periods num
    // example: "90|95|60|2"
    const ec2tagRule = new Rule(this, 'TagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['ec2', 'ecs', 'rds'],
          'resource-type': ['instance'],
          'changed-tag-keys': [
            'autoalarm:enabled',
            'autoalarm:ec2-cpu',
            'autoalarm:ec2-storage',
            'autoalarm:ec2-memory',
            'autoalarm:target', // cloudwatch or prometheus
          ],
        },
      },
      description: 'Routes tag events to AutoAlarm',
    });
    ec2tagRule.addTarget(mainTarget);

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

    // Rule for ALB tag changes
    // Listen to tag changes related to AutoAlarm
    // WARNING threshold num | CRITICAL threshold num | duration time num | duration periods num
    // example: "1500|1750|60|2"
    const albTagRule = new Rule(this, 'AlbTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['elasticloadbalancing'],
          'resource-type': ['loadbalancer'],
          'changed-tag-keys': [
            'autoalarm:enabled',
            'autoalarm:alb-request-count',
            'autoalarm:alb-HTTPCode_ELB_4XX_Count',
            'autoalarm:alb-HTTPCode_ELB_5XX',
          ],
        },
      },
      description: 'Routes ALB tag events to AutoAlarm',
    });
    albTagRule.addTarget(mainTarget);

    // Rule for ALB events
    const albRule = new Rule(this, 'AlbRule', {
      eventPattern: {
        source: ['aws.elasticloadbalancing'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['elasticloadbalancing.amazonaws.com'],
          eventName: ['CreateLoadBalancer', 'DeleteLoadBalancer'],
        },
      },
      description: 'Routes ALB events to AutoAlarm',
    });
    albRule.addTarget(mainTarget);

    // Rule for Target Group tag changes
    const targetGroupTagRule = new Rule(this, 'TargetGroupTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['elasticloadbalancing'],
          'resource-type': ['targetgroup'],
          'changed-tag-keys': [
            'autoalarm:enabled',
            'autoalarm:TargetResponseTime',
            'autoalarm:HTTPCode_Target_4XX',
            'autoalarm:HTTPCode_Target_5XX',
          ],
        },
      },
      description: 'Routes Target Group tag events to AutoAlarm',
    });
    targetGroupTagRule.addTarget(mainTarget);

    const targetGroupRule = new Rule(this, 'TargetGroupRule', {
      eventPattern: {
        source: ['aws.elasticloadbalancing'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['elasticloadbalancing.amazonaws.com'],
          eventName: ['CreateTargetGroup', 'DeleteTargetGroup'],
        },
      },
      description: 'Routes Target Group events to AutoAlarm',
    });
    targetGroupRule.addTarget(mainTarget);

    // Rule for SQS tag changes
    const sqsTagRule = new Rule(this, 'SqsTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['sqs'],
          'resource-type': ['AWS::SQS::Queue'],
          'changed-tag-keys': [
            'autoalarm:disabled',
            'autoalarm:ApproximateNumberOfMessagesVisible-above-critical',
            'autoalarm:ApproximateNumberOfMessagesVisible-above-warning',
            'autoalarm:ApproximateNumberOfMessagesVisible-duration-time',
            'autoalarm:ApproximateNumberOfMessagesVisible-duration-periods',
            'autoalarm:ApproximateAgeOfOldestMessage-above-critical',
            'autoalarm:ApproximateAgeOfOldestMessage-above-warning',
            'autoalarm:ApproximateAgeOfOldestMessage-duration-time',
            'autoalarm:ApproximateAgeOfOldestMessage-duration-periods',
          ],
        },
      },
      description: 'Routes SQS tag events to AutoAlarm',
    });
    sqsTagRule.addTarget(mainTarget);

    // Rule for OpenSearch tag changes
    const openSearchTagRule = new Rule(this, 'OpenSearchTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['es'],
          'resource-type': ['domain'],
          'changed-tag-keys': [
            'autoalarm:disabled',
            'autoalarm:ClusterStatus.yellow-above-critical',
            'autoalarm:ClusterStatus.yellow-above-warning',
            'autoalarm:ClusterStatus.yellow-duration-time',
            'autoalarm:ClusterStatus.yellow-duration-periods',
            'autoalarm:ClusterStatus.red-above-critical',
            'autoalarm:ClusterStatus.red-above-warning',
            'autoalarm:ClusterStatus.red-duration-time',
            'autoalarm:ClusterStatus.red-duration-periods',
            'autoalarm:FreeStorageSpace-above-critical',
            'autoalarm:FreeStorageSpace-above-warning',
            'autoalarm:FreeStorageSpace-duration-time',
            'autoalarm:FreeStorageSpace-duration-periods',
            'autoalarm:JVMMemoryPressure-above-critical',
            'autoalarm:JVMMemoryPressure-above-warning',
            'autoalarm:JVMMemoryPressure-duration-time',
            'autoalarm:JVMMemoryPressure-duration-periods',
            'autoalarm:CPUUtilization-above-critical',
            'autoalarm:CPUUtilization-above-warning',
            'autoalarm:CPUUtilization-duration-time',
            'autoalarm:CPUUtilization-duration-periods',
          ],
        },
      },
      description: 'Routes OpenSearch tag events to AutoAlarm',
    });
    openSearchTagRule.addTarget(mainTarget);

    // Rule for SQS events
    const sqsRule = new Rule(this, 'SqsRule', {
      eventPattern: {
        source: ['aws.sqs'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['sqs.amazonaws.com'],
          eventName: ['CreateQueue', 'DeleteQueue'],
        },
      },
      description: 'Routes SQS events to AutoAlarm',
    });
    sqsRule.addTarget(mainTarget);

    // Rule for OpenSearch events
    const openSearchRule = new Rule(this, 'OpenSearchRule', {
      eventPattern: {
        source: ['aws.es'],
        detailType: ['Elasticsearch Service Domain Change'],
        detail: {
          state: ['active', 'processing', 'deleted'],
        },
      },
      description: 'Routes OpenSearch events to AutoAlarm',
    });
    openSearchRule.addTarget(mainTarget);
  }
}
