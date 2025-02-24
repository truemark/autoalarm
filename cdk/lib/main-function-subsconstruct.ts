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
import {Duration} from 'aws-cdk-lib';
import {Architecture} from 'aws-cdk-lib/aws-lambda';
import {ExtendedQueue} from 'truemark-cdk-lib/aws-sqs';
import {SqsEventSource} from 'aws-cdk-lib/aws-lambda-event-sources';

export class AutoAlarm extends Construct {
  public readonly lambdaFunction: ExtendedNodejsFunction;
  public readonly mainFunctionQueues: {[key: string]: ExtendedQueue};

  constructor(
    scope: Construct,
    id: string,
    region: string,
    accountId: string,
    prometheusArn: string,
    prometheusWorkspaceId: string,
  ) {
    super(scope, id);
    /**
     * Set up the IAM role and policies for the main function
     */
    const role = this.createRole(
      region,
      accountId,
      prometheusArn,
      prometheusWorkspaceId,
    );

    /**
     * Create Node function definition
     */
    this.lambdaFunction = this.createFunction(role, prometheusWorkspaceId);

    /**
     * Create all the queues for all the services that AutoAlarm supports
     */
    this.mainFunctionQueues = this.createQueues();
  }

  /**
   * Private method to create all the queues for all the services that AutoAlarm supports
   */
  private createQueues(): {[key: string]: ExtendedQueue} {
    //Create a string array of all the autoAlarmQueue names
    const autoAlarmQueues = [
      'autoAlarmAlb',
      'autoAlarmCloudfront',
      'autoAlarmEc2',
      'autoAlarmOpenSearchRule',
      'autoAlarmRds',
      'autoAlarmRdsCluster',
      'autoAlarmRoute53resolver',
      'autoAlarmSqs',
      'autoAlarmTargetGroup',
      'autoAlarmTransitGateway',
      'autoAlarmVpn',
    ];

    //Create a custom object that contains/will constain all our fifo queues
    const queues: {[key: string]: ExtendedQueue} = {};

    /**
     * Loop through the autoAlarmQueues array and create a new ExtendedQueue object for each queue and add it to queues object
     * Grant consume messages to the mainFunction for each queue
     * Finally add an event source to the mainFunction for each queue
     */
    for (const queueName of autoAlarmQueues) {
      // Create DLQ for each queue and let cdk handle the name generation after the queue name
      const dlq = new ExtendedQueue(this, `${queueName}-Failed`, {
        fifo: true,
        retentionPeriod: Duration.days(14),
      });

      // Create queue with its own DLQ
      queues[queueName] = new ExtendedQueue(this, queueName, {
        fifo: true,
        contentBasedDeduplication: true,
        retentionPeriod: Duration.days(14),
        visibilityTimeout: Duration.seconds(900),
        deadLetterQueue: {queue: dlq, maxReceiveCount: 3},
      });

      queues[queueName].grantConsumeMessages(this.lambdaFunction);
      this.lambdaFunction.addEventSource(
        new SqsEventSource(queues[queueName], {
          batchSize: 10,
          reportBatchItemFailures: true,
          enabled: true,
        }),
      );
    }

    return queues;
  }

  /**
   * private method to create role and IAM policy for the function
   */
  private createRole(
    region: string,
    accountId: string,
    prometheusArn: string,
    prometheusWorkspaceId: string,
  ): IRole {
    /**
     * Set up the IAM role and policies for the main function
     */
    const autoAlarmExecutionRole = new Role(this, 'autoAlarmExecutionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for AutoAlarm Lambda function',
    });

    // Attach policies for Prometheus
    autoAlarmExecutionRole.addToPolicy(
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
      }),
    );

    // Attach policies for EC2 and CloudWatch
    autoAlarmExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'ec2:DescribeInstances',
          'ec2:DescribeTags',
          'cloudwatch:PutMetricAlarm',
          'cloudwatch:DeleteAlarms',
          'cloudwatch:DescribeAlarms',
          'cloudwatch:ListMetrics',
          'cloudwatch:PutAnomalyDetector',
        ],
        resources: ['*'],
      }),
    );

    // Attach policies for CloudWatch Logs
    autoAlarmExecutionRole.addToPolicy(
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

    // Attach policies for ALB and Target Groups
    autoAlarmExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'elasticloadbalancing:DescribeLoadBalancers',
          'elasticloadbalancing:DescribeTags',
          'elasticloadbalancing:DescribeTargetGroups',
          'elasticloadbalancing:DescribeTargetHealth',
        ],
        resources: ['*'],
      }),
    );

    // Attach policies for SQS
    autoAlarmExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'sqs:GetQueueAttributes',
          'sqs:GetQueueUrl',
          'sqs:ListQueues',
          'sqs:ListQueueTags',
        ],
        resources: ['*'],
      }),
    );

    // Attach policies for OpenSearch
    autoAlarmExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'es:DescribeElasticsearchDomain',
          'es:ListDomainNames',
          'es:ListTags',
        ],
        resources: ['*'],
      }),
    );

    // Attach policies for Transit Gateway
    autoAlarmExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ec2:DescribeTransitGateways'],
        resources: ['*'],
      }),
    );

    // Attach policies for RDS
    autoAlarmExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'rds:DescribeDBInstances',
          'rds:ListTagsForResource',
          'rds:DescribeDBClusters',
        ],
        resources: ['*'],
      }),
    );

    // Attach policies for Route53Resolver
    autoAlarmExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'route53resolver:ListResolverEndpoints',
          'route53resolver:ListTagsForResource',
        ],
        resources: ['*'],
      }),
    );

    // Attach policies for CloudFront
    autoAlarmExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'cloudfront:GetDistribution',
          'cloudfront:ListDistributions',
          'cloudfront:ListTagsForResource',
        ],
        resources: ['*'],
      }),
    );

    // Attach policies for VPN
    autoAlarmExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ec2:DescribeVpnConnections'],
        resources: ['*'],
      }),
    );

    return autoAlarmExecutionRole;
  }

  /**
   * private method initialize the main function
   */
  private createFunction(
    role: IRole,
    prometheusWorkspaceId: string,
  ): ExtendedNodejsFunction {
    // Create the main function
    return new ExtendedNodejsFunction(this, 'mainFunction', {
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
      role: role,
      environment: {
        PROMETHEUS_WORKSPACE_ID: prometheusWorkspaceId,
      },
      bundling: {
        nodeModules: ['@smithy/util-retry'],
      },
      deploymentOptions: {
        createDeployment: false,
      },
    });
  }
}
