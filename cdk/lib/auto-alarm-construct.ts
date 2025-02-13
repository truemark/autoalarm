import {Construct} from 'constructs';
import {MainFunction} from './main-function';
import {ReAlarmProducerFunction} from './realarm-producer-function';
import {ReAlarmConsumerFunction} from './realarm-consumer-function';
import {
  ExtendedQueue,
  ExtendedQueueProps,
  StandardQueue,
} from 'truemark-cdk-lib/aws-sqs';
import {Rule, Schedule} from 'aws-cdk-lib/aws-events';
import {LambdaFunction, SqsQueue} from 'aws-cdk-lib/aws-events-targets';
import {SqsEventSource} from 'aws-cdk-lib/aws-lambda-event-sources';
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  Effect,
} from 'aws-cdk-lib/aws-iam';
import {Duration, Stack} from 'aws-cdk-lib';
import {ReAlarmEventRuleFunction} from './realarm-event-rule-function';

export interface AutoAlarmConstructProps {
  readonly prometheusWorkspaceId?: string;
  readonly enableReAlarm?: boolean;
}

export class AutoAlarmConstruct extends Construct {
  public readonly reAlarmProducerFunctionARN: string;
  constructor(scope: Construct, id: string, props: AutoAlarmConstructProps) {
    super(scope, id);

    //the following four consts are used to pass the correct ARN for whichever prometheus ID is being used as well as to the lambda.
    const prometheusWorkspaceId = props.prometheusWorkspaceId || '';
    const accountId = Stack.of(this).account;
    const region = Stack.of(this).region;
    const prometheusArn = `arn:aws:aps:${region}:${accountId}:workspace/${prometheusWorkspaceId}`;

    const enableReAlarm = props.enableReAlarm ?? true;

    if (enableReAlarm) {
      /**
       *
       * Create the realarm consumer queue to receive events from producer and process alarms
       * Create the realarm event rule queue to receive events from event rule lambda and process event rule changes
       */
      const reAlarmConsumerQueue = new StandardQueue(
        this,
        'ReAlarmConsumerQueue',
        {
          retentionPeriod: Duration.days(14),
          visibilityTimeout: Duration.seconds(900),
          maxReceiveCount: 3,
        },
      );

      const reAlarmEventRuleQueue = new StandardQueue(
        this,
        'ReAlarmEventRuleQueue',
        {
          retentionPeriod: Duration.days(14),
          visibilityTimeout: Duration.seconds(900),
          maxReceiveCount: 3,
        },
      );

      /**
       * EventRule Lambda role setup
       * Allow the Event Rule Lambda function to create and delete Event Rules
       * Allow the Event Rule Lambda function to describe alarms and list tags
       * Allow the Event Rule Lambda function to create and write to CloudWatch Logs
       * Allow the Event Rule Lambda function to consume messages from the Event Rule queue
       */
      const reAlarmEventRuleLambdaExecutionRole = new Role(
        this,
        'reAlarmEventRuleLambdaExecutionRole',
        {
          assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
          description: 'Execution role for ReAlarm Event Rule Lambda function',
        },
      );

      reAlarmEventRuleLambdaExecutionRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'events:PutRule',
            'events:PutTargets',
            'events:DeleteRule',
            'events:RemoveTargets',
          ],
          resources: [
            `arn:aws:events:${region}:${accountId}:rule/AutoAlarm-ReAlarm-*`,
          ],
        }),
      );

      reAlarmEventRuleLambdaExecutionRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'cloudwatch:DescribeAlarms',
            'cloudwatch:ListTagsForResource',
          ],
          resources: ['*'],
        }),
      );

      reAlarmEventRuleLambdaExecutionRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          resources: ['*'],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
          ],
        }),
      );

      reAlarmEventRuleLambdaExecutionRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:GetQueueAttributes',
            'sqs:GetQueueUrl',
          ],
          resources: [reAlarmEventRuleQueue.queueArn],
        }),
      );

      /*
       * Set up the IAM roles for the ReAlarm Producer function
       * Allow the producer to describe alarms and list tags
       * Allow the producer to send messages to the consumer queue
       * Allow the producer to write to CloudWatch Logs
       *
       */
      const reAlarmProducerRole = new Role(this, 'reAlarmProducerRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        description: 'Execution role for ReAlarm Producer Lambda function',
      });

      reAlarmProducerRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'cloudwatch:DescribeAlarms',
            'cloudwatch:ListTagsForResource',
          ],
          resources: ['*'],
        }),
      );

      reAlarmProducerRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'sqs:SendMessage',
            'sqs:SendMessageBatch',
            'sqs:GetQueueUrl',
          ],
          resources: [reAlarmConsumerQueue.queueArn],
        }),
      );

      reAlarmProducerRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          resources: ['*'],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
          ],
        }),
      );

      /**
       * Set up the IAM roles for the ReAlarm Consumer function
       * Allow the consumer to describe alarms and list tags
       * Allow the consumer to set alarm state
       * Allow the consumer to write to CloudWatch Logs
       * Allow Consumer to consume messages from the Consumer queue
       */
      const reAlarmConsumerRole = new Role(this, 'reAlarmConsumerRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        description: 'Execution role for ReAlarm Consumer Lambda function',
      });

      reAlarmConsumerRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'cloudwatch:DescribeAlarms',
            'cloudwatch:SetAlarmState',
            'cloudwatch:ListTagsForResource',
          ],
          resources: ['*'],
        }),
      );

      reAlarmConsumerRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          resources: ['*'],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
          ],
        }),
      );

      reAlarmConsumerRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:GetQueueAttributes',
            'sqs:GetQueueUrl',
          ],
          resources: [reAlarmConsumerQueue.queueArn],
        }),
      );

      /**
       * ReAlarm Lambda Functions Setup
       * ---------------------
       * 1. Consumer Lambda: Consumes messages from consumer queue and processes alarms
       * 2. Producer Lambda: grabs all alarms, applies pre-filtering and routes  to consumer queue
       * 3. Event Rule Lambda: Creates/deletes EventBridge rules for alarm tag changes
       *
       * Note: The producer function ARN is stored for use in the event rule lambda.
       *
       * when the event rule function creates override schedule rules. In future iterations,
       * this will be replaced with SQS queue integration, eliminating the need for direct
       * Lambda invocation.
       */

      const reAlarmConsumerFunction = new ReAlarmConsumerFunction(
        this,
        'ReAlarmConsumerFunction',
        {
          role: reAlarmConsumerRole,
        },
      );

      const reAlarmProducerFunction = new ReAlarmProducerFunction(
        this,
        'ReAlarmProducerFunction',
        {
          role: reAlarmProducerRole,
          environment: {
            QUEUE_URL: reAlarmConsumerQueue.queueUrl,
          },
        },
      );

      reAlarmProducerFunction.addPermission('EventBridgePermission', {
        principal: new ServicePrincipal('events.amazonaws.com'),
        sourceArn: `arn:aws:events:${region}:${accountId}:rule/AutoAlarm-ReAlarm-*`,
      });

      this.reAlarmProducerFunctionARN = reAlarmProducerFunction.functionArn;

      const reAlarmEventRuleFunction = new ReAlarmEventRuleFunction(
        this,
        'ReAlarmEventRuleFunction',
        {
          role: reAlarmEventRuleLambdaExecutionRole,
          reAlarmFunctionArn: this.reAlarmProducerFunctionARN, // this is used as the target for EventBridge rules
        },
      );

      /**
       * Allow reAlarm event rule lambda function to consume messages from the event rule queue
       * Allow the producer to send messages to the consumer queue
       * Allow the consumer to consume messages from the consumer queue
       * Add the consumer function as an event source for the consumer queue
       * Store Producer function ARN for use in Event Rule Lambda function
       */
      reAlarmEventRuleQueue.grantConsumeMessages(reAlarmEventRuleFunction);
      reAlarmConsumerQueue.grantSendMessages(reAlarmProducerFunction);
      reAlarmConsumerQueue.grantConsumeMessages(reAlarmConsumerFunction);

      /**
       *
       * Add consumer queue as an event source for the reAlarm consumer function
       * Add event rule queue as an event source for the reAlarm event rule function
       */

      reAlarmConsumerFunction.addEventSource(
        new SqsEventSource(reAlarmConsumerQueue, {
          batchSize: 10,
          maxBatchingWindow: Duration.seconds(30),
          reportBatchItemFailures: true,
        }),
      );

      reAlarmEventRuleFunction.addEventSource(
        new SqsEventSource(reAlarmEventRuleQueue, {
          batchSize: 10,
          maxBatchingWindow: Duration.seconds(30),
          reportBatchItemFailures: true,
        }),
      );

      /**
       * Create the reAlarm Schedule event bridge rule to trigger the ReAlarm Producer function on a schedule
       */
      const reAlarmScheduleRule = new Rule(this, 'ReAlarmScheduleRule', {
        schedule: Schedule.rate(Duration.minutes(120)),
        description:
          'Trigger the ReAlarm Producer function according to schedule',
      });

      reAlarmScheduleRule.addTarget(
        new LambdaFunction(reAlarmProducerFunction),
      );

      /**
       * Create the Event Rule to trigger the ReAlarm Event Rule queue on tag changes
       */
      const reAlarmEventRuleTagRule = new Rule(
        this,
        'ReAlarmEventRuleTagRule',
        {
          eventPattern: {
            source: ['aws.tag'],
            detailType: ['Tag Change on Resource'],
            detail: {
              'service': ['cloudwatch'],
              'resource-type': ['alarm'],
              'changed-tag-keys': [
                'autoalarm:re-alarm-minutes',
                'autoalarm:re-alarm-enabled',
              ],
            },
          },
          description:
            'Trigger the ReAlarm Event Rule Lambda function for tag changes',
        },
      );

      reAlarmEventRuleTagRule.addTarget(new SqsQueue(reAlarmEventRuleQueue));
    }

    /**
     * Create the MainFunction and associated resources
     * configure the AutoAlarm Function and associated queues and eventbridge rules
     */

    // Define the IAM role with specific permissions for the AutoAlarm Lambda function
    const mainFunctionExecutionRole = new Role(
      this,
      'mainFunctionExecutionRole',
      {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        description: 'Execution role for AutoAlarm Lambda function',
      },
    );

    // Attach policies for Prometheus
    mainFunctionExecutionRole.addToPolicy(
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
    mainFunctionExecutionRole.addToPolicy(
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
    mainFunctionExecutionRole.addToPolicy(
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
    mainFunctionExecutionRole.addToPolicy(
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
    mainFunctionExecutionRole.addToPolicy(
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
    mainFunctionExecutionRole.addToPolicy(
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
    mainFunctionExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ec2:DescribeTransitGateways'],
        resources: ['*'],
      }),
    );

    // Attach policies for RDS
    mainFunctionExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['rds:DescribeDBInstances', 'rds:ListTagsForResource'],
        resources: ['*'],
      }),
    );

    // Attach policies for Route53Resolver
    mainFunctionExecutionRole.addToPolicy(
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
    mainFunctionExecutionRole.addToPolicy(
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
    mainFunctionExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ec2:DescribeVpnConnections'],
        resources: ['*'],
      }),
    );

    // Create the MainFunction and explicitly pass the execution role
    const mainFunction = new MainFunction(this, 'MainFunction', {
      role: mainFunctionExecutionRole, // Pass the role here
      prometheusWorkspaceId: prometheusWorkspaceId,
    });

    // Create autoAlarmDLQ
    const autoAlarmDLQ = new ExtendedQueue(this, 'MainFunctionDLQ', {
      fifo: true,
      retentionPeriod: Duration.days(14),
    });

    // Define extended queue props for autoAlarmQueue
    const queueProps: ExtendedQueueProps = {
      fifo: true, // Enable FIFO
      contentBasedDeduplication: true, // Enable idempotency
      retentionPeriod: Duration.days(14), // Retain messages for 14 days
      visibilityTimeout: Duration.seconds(900), // Set visibility timeout to 15 minutes to match the AutoAlarm function timeout
      deadLetterQueue: {queue: autoAlarmDLQ, maxReceiveCount: 3}, // Set the dead letter queue
    };

    // Create the autoAlarmQueue
    const autoAlarmQueue = new ExtendedQueue(
      this,
      'MainFunctionQueue',
      queueProps,
    );
    autoAlarmQueue.grantConsumeMessages(mainFunction);

    // Add Event Source to the MainFunction
    mainFunction.addEventSource(
      new SqsEventSource(autoAlarmQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
        enabled: true,
      }),
    );

    // TODO: Add all event rules in alphabetical order
    const ec2tagRule = new Rule(this, 'TagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          'service': ['ec2', 'ecs', 'rds'],
          'resource-type': ['instance'],
          'changed-tag-keys': [
            'autoalarm:enabled',
            'autoalarm:cpu',
            'autoalarm:storage',
            'autoalarm:memory',
            'autoalarm:cpu-anomaly',
            'autoalarm:storage-anomaly',
            'autoalarm:memory-anomaly',
            'autoalarm:target', // cloudwatch or prometheus
          ],
        },
      },
      description: 'Routes tag events to AutoAlarm',
    });
    ec2tagRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    const ec2Rule = new Rule(this, 'Ec2Rule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: {
          state: [
            'running',
            'terminated',
            //'stopped', //for testing only
            //'shutting-down', //to be removed. for testing only
            //'pending',
          ],
        },
      },
      description: 'Routes ec2 instance events to AutoAlarm',
    });
    ec2Rule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    //Rule for ALB tag changes
    //Listen to tag changes related to AutoAlarm
    //WARNING threshold num | CRITICAL threshold num | duration time num | duration periods num
    //example: "1500|1750|60|2"
    const albTagRule = new Rule(this, 'AlbTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          'service': ['elasticloadbalancing'],
          'resource-type': ['loadbalancer'],
          'changed-tag-keys': [
            'autoalarm:enabled',
            'autoalarm:request-count',
            'autoalarm:4xx-count',
            'autoalarm:5xx-count',
            'autoalarm:response-time',
            'autoalarm:request-count-anomaly',
            'autoalarm:4xx-count-anomaly',
            'autoalarm:5xx-count-anomaly',
            'autoalarm:response-time-anomaly',
          ],
        },
      },
      description: 'Routes ALB tag events to AutoAlarm',
    });
    albTagRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    //Rule for ALB events
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
    albRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    // Rule for Target Group tag changes
    const targetGroupTagRule = new Rule(this, 'TargetGroupTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          'service': ['elasticloadbalancing'],
          'resource-type': ['targetgroup'],
          'changed-tag-keys': [
            'autoalarm:enabled',
            'autoalarm:unhealthy-host-count',
            'autoalarm:response-time',
            'autoalarm:request-count',
            'autoalarm:4xx-count',
            'autoalarm:5xx-count',
            'autoalarm:unhealthy-host-count-anomaly',
            'autoalarm:request-count-anomaly',
            'autoalarm:response-time-anomaly',
            'autoalarm:4xx-count-anomaly',
            'autoalarm:5xx-count-anomaly',
          ],
        },
      },
      description: 'Routes Target Group tag events to AutoAlarm',
    });
    targetGroupTagRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

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
    targetGroupRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    // Rule for OpenSearch tag changes
    const openSearchTagRule = new Rule(this, 'OpenSearchTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          'service': ['es'],
          'resource-type': ['domain'],
          'changed-tag-keys': [
            'autoalarm:enabled',
            'autoalarm:4xx-errors',
            'autoalarm:4xx-errors-anomaly',
            'autoalarm:5xx-errors',
            'autoalarm:5xx-errors-anomaly',
            'autoalarm:cpu',
            'autoalarm:cpu-anomaly',
            'autoalarm:iops-throttle',
            'autoalarm:iops-throttle-anomaly',
            'autoalarm:jvm-memory',
            'autoalarm:jvm-memory-anomaly',
            'autoalarm:read-latency',
            'autoalarm:read-latency-anomaly',
            'autoalarm:search-latency',
            'autoalarm:search-latency-anomaly',
            'autoalarm:snapshot-failure',
            'autoalarm:snapshot-failure-anomaly',
            'autoalarm:storage',
            'autoalarm:storage-anomaly',
            'autoalarm:sys-memory-util',
            'autoalarm:sys-memory-util-anomaly',
            'autoalarm:throughput-throttle',
            'autoalarm:throughput-throttle-anomaly',
            'autoalarm:write-latency',
            'autoalarm:write-latency-anomaly',
            'autoalarm:yellow-cluster',
            'autoalarm:yellow-cluster-anomaly',
            'autoalarm:red-cluster',
            'autoalarm:red-cluster-anomaly',
          ],
        },
      },
      description: 'Routes OpenSearch tag events to AutoAlarm',
    });
    openSearchTagRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    //Rule for SQS events
    const sqsRule = new Rule(this, 'SqsRule', {
      eventPattern: {
        source: ['aws.sqs'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['sqs.amazonaws.com'],
          eventName: ['CreateQueue', 'DeleteQueue', 'TagQueue', 'UntagQueue'],
        },
      },
      description: 'Routes SQS events to AutoAlarm',
    });
    sqsRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    //Rule for OpenSearch events
    const openSearchRule = new Rule(this, 'OpenSearchRule', {
      eventPattern: {
        source: ['aws.es'],
        detailType: ['Elasticsearch Service Domain Change'],
        detail: {
          state: ['CreateDomain', 'DeleteDomain'],
        },
      },
      description: 'Routes OpenSearch events to AutoAlarm',
    });
    openSearchRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    // Rule for Transit Gateway events
    const transitGatewayRule = new Rule(this, 'TransitGatewayRule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['ec2.amazonaws.com'],
          eventName: ['CreateTransitGateway', 'DeleteTransitGateway'],
        },
      },
      description: 'Routes Transit Gateway events to AutoAlarm',
    });
    transitGatewayRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    // Rule for Transit Gateway Tag changes
    const transitGatewayTagRule = new Rule(this, 'TransitGatewayTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          'service': ['ec2'],
          'resource-type': ['transit-gateway'],
          'changed-tag-keys': [
            'autoalarm:enabled',
            'autoalarm:bytes-in',
            'autoalarm:bytes-in-anomaly',
            'autoalarm:bytes-out',
            'autoalarm:bytes-out-anomaly',
          ],
        },
      },
      description: 'Routes Transit Gateway tag events to AutoAlarm',
    });
    transitGatewayTagRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    // Rule for Route53Resolver events
    const route53ResolverRule = new Rule(this, 'Route53ResolverRule', {
      eventPattern: {
        source: ['aws.route53resolver'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['route53resolver.amazonaws.com'],
          eventName: ['CreateResolverEndpoint', 'DeleteResolverEndpoint'],
        },
      },
      description: 'Routes Route53Resolver events to AutoAlarm',
    });
    route53ResolverRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    // Rule for Route53Resolver tag changes
    const route53ResolverTagRule = new Rule(this, 'Route53ResolverTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          'service': ['route53resolver'],
          'resource-type': ['resolver-endpoint'],
          'changed-tag-keys': [
            'autoalarm:enabled',
            'autoalarm:inbound-query-volume',
            'autoalarm:inbound-query-volume-anomaly',
            'autoalarm:outbound-query-volume',
            'autoalarm:outbound-query-volume-anomaly',
          ],
        },
      },
      description: 'Routes Route53Resolver tag events to AutoAlarm',
    });
    route53ResolverTagRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    // Rule for VPN events
    const vpnRule = new Rule(this, 'VPNRule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['ec2.amazonaws.com'],
          eventName: ['CreateVpnConnection', 'DeleteVpnConnection'],
        },
      },
      description: 'Routes VPN events to AutoAlarm',
    });
    vpnRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    // Rule for VPN tag changes
    const vpnTagRule = new Rule(this, 'VPNTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          'service': ['ec2'],
          'resource-type': ['vpn-connection'],
          'changed-tag-keys': [
            'autoalarm:enabled',
            'autoalarm:tunnel-state',
            'autoalarm:tunnel-state-anomaly',
          ],
        },
      },
      description: 'Routes VPN tag events to AutoAlarm',
    });
    vpnTagRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    // Rule for CloudFront events
    const cloudFrontRule = new Rule(this, 'CloudFrontRule', {
      eventPattern: {
        source: ['aws.cloudfront'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['cloudfront.amazonaws.com'],
          eventName: ['CreateDistribution', 'DeleteDistribution'],
        },
      },
      description: 'Routes CloudFront events to AutoAlarm',
    });
    cloudFrontRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    // Rule for CloudFront tag changes
    const cloudFrontTagRule = new Rule(this, 'CloudFrontTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          'service': ['cloudfront'],
          'resource-type': ['distribution'],
          'changed-tag-keys': [
            'autoalarm:enabled',
            'autoalarm:4xx-errors',
            'autoalarm:4xx-errors-anomaly',
            'autoalarm:5xx-errors',
            'autoalarm:5xx-errors-anomaly',
          ],
        },
      },
      description: 'Routes CloudFront tag events to AutoAlarm',
    });
    cloudFrontTagRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    // Rule for RDS events
    const rdsRule = new Rule(this, 'RDSRule', {
      eventPattern: {
        source: ['aws.rds'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['rds.amazonaws.com'],
          eventName: [
            'CreateDBInstance',
            'DeleteDBInstance',
//            'AddTagsToResource', //TODO: Should we remove this? Need to test and see if we're getting duplicate calls
          ],
        },
      },
      description: 'Routes RDS events to AutoAlarm',
    });
    rdsRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );

    // Rule for RDS tag changes

    const rdsTagRule = new Rule(this, 'RDSTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          'service': ['rds'],
          'resource-type': ['db-instance'],
          'changed-tag-keys': [
            'autoalarm:enabled',
            'autoalarm:cpu',
            'autoalarm:cpu-anomaly',
            'autoalarm:write-latency',
            'autoalarm:write-latency-anomaly',
            'autoalarm:read-latency',
            'autoalarm:read-latency-anomaly',
            'autoalarm:freeable-memory',
            'autoalarm:freeable-memory-anomaly',
            'autoalarm:db-connections',
            'autoalarm:db-connections-anomaly',
          ],
        },
      },
      description: 'Routes RDS tag events to AutoAlarm',
    });
    rdsTagRule.addTarget(
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AutoAlarm'}),
    );
  }
}
