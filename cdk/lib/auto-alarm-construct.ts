import {Construct} from 'constructs';
import {MainFunction} from './main-function';
import {ReAlarmFunction} from './realarm-function';
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

export interface AutoAlarmConstructProps {
  readonly prometheusWorkspaceId?: string;
}

export class AutoAlarmConstruct extends Construct {
  constructor(scope: Construct, id: string, props: AutoAlarmConstructProps) {
    super(scope, id);

    //the following four consts are used to pass the correct ARN for whichever prometheus ID is being used as well as to the lambda.
    const prometheusWorkspaceId = props.prometheusWorkspaceId || '';
    const accountId = Stack.of(this).account;
    const region = Stack.of(this).region;
    const prometheusArn = `arn:aws:aps:${region}:${accountId}:workspace/${prometheusWorkspaceId}`;

    /*
     * configure the ReAlarm Function and associated queues and eventbridge rules
     */

    // Define the IAM role with specific permissions for the ReAlarm Lambda function
    const reAlarmLambdaExecutionRole = new Role(
      this,
      'reAlarmLambdaExecutionRole',
      {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        description: 'Execution role for AutoAlarm Lambda function',
      }
    );

    // Attach policies for EC2 and CloudWatch
    reAlarmLambdaExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['cloudwatch:DescribeAlarms', 'cloudwatch:SetAlarmState'],
        resources: ['*'],
      })
    );

    // Attach policies for CloudWatch Logs
    reAlarmLambdaExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        resources: [
          `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/cwsyn*`,
          `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/cwsyn*:log-stream:*`,
          `arn:aws:logs:${region}:${accountId}:log-group:/aws/canary/*`,
        ],
        actions: [
          'logs:FilterLogEvents',
          'logs:DescribeLogStreams',
          'logs:DescribeLogGroups',
        ],
      })
    );

    reAlarmLambdaExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        resources: ['*'],
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
      })
    );

    reAlarmLambdaExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        resources: ['*'], // This grants permission on all log groups. Adjust if needed.
        actions: ['logs:DescribeLogGroups'],
      })
    );

    // Create the MainFunction and explicitly pass the execution role
    const reAlarmFunction = new ReAlarmFunction(this, 'ReAlarmFunction', {
      role: reAlarmLambdaExecutionRole,
    });

    const deadLetterQueue = new StandardQueue(this, 'DeadLetterQueue');
    const reAlarmTarget = new LambdaFunction(reAlarmFunction, {
      deadLetterQueue,
    });

    //Define timed event to trigger the lambda function
    const everyTwoHoursRule = new Rule(this, 'EveryTwoHoursRule', {
      schedule: Schedule.cron({hour: '*/2'}),
      description: 'Trigger the ReAlarm Lambda function every two hours',
    });

    everyTwoHoursRule.addTarget(reAlarmTarget);

    /*
     * configure the AutoAlarm Function and associated queues and eventbridge rules
     */

    // Define the IAM role with specific permissions for the AutoAlarm Lambda function
    const mainFunctionExecutionRole = new Role(
      this,
      'mainFunctionExecutionRole',
      {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        description: 'Execution role for AutoAlarm Lambda function',
      }
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
      })
    );

    // Attach policies for autoAlarmQueue.fifo
    mainFunctionExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'sqs:ReceiveMessage', // Allows receiving messages from the queue
          'sqs:DeleteMessage', // Allows deleting messages from the queue
          'sqs:GetQueueAttributes', // Allows getting queue attributes
          'sqs:ChangeMessageVisibility', // Allows modifying visibility timeout
          'sqs:GetQueueUrl', // Allows getting the queue URL
          'sqs:ListQueues', // Allows listing queues
          'sqs:ListQueueTags', // Allows listing tags for the queue
        ],
        resources: [
          `arn:aws:sqs:${region}:${accountId}:AutoAlarm-mainFunctionQueue.fifo`,
        ], // Grant access to the FIFO queue
      })
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
      })
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
      })
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
      })
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
      })
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
      })
    );

    // Attach policies for Transit Gateway
    mainFunctionExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ec2:DescribeTransitGateways'],
        resources: ['*'],
      })
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
      })
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
      })
    );

    // Attach policies for VPN
    mainFunctionExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ec2:DescribeVpnConnections'],
        resources: ['*'],
      })
    );

    // Create the MainFunction and explicitly pass the execution role
    const mainFunction = new MainFunction(this, 'MainFunction', {
      role: mainFunctionExecutionRole, // Pass the role here
      prometheusWorkspaceId: prometheusWorkspaceId,
    });

    // Create autoAlarmDLQ
    const autoAlarmDLQ = new ExtendedQueue(this, 'autoAlarmDLQ', {
      fifo: true,
      retentionPeriod: Duration.days(14),
      queueName: 'AutoAlarm-deadLetterQueue.fifo',
    });

    // Define extended queue props for autoAlarmQueue
    const queueProps: ExtendedQueueProps = {
      fifo: true, // Enable FIFO
      contentBasedDeduplication: true, // Enable idempotency
      retentionPeriod: Duration.days(14), // Retain messages for 14 days
      deadLetterQueue: {queue: autoAlarmDLQ, maxReceiveCount: 3},
      visibilityTimeout: Duration.seconds(900), // Set visibility timeout to 15 minutes to match the AutoAlarm function timeout
      queueName: 'AutoAlarm-mainFunctionQueue.fifo',
    };

    // Create the autoAlarmQueue
    const autoAlarmQueue = new ExtendedQueue(
      this,
      'AutoAlarm-mainFunctionQueue',
      queueProps
    );

    // Add Event Source to the MainFunction
    mainFunction.addEventSource(
      new SqsEventSource(autoAlarmQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
        enabled: true,
      })
    );

    /* Listen to tag changes related to AutoAlarm. Anomaly Alarms are standard and Cloudwatch Alarms are optional.
     * If cloudwatch Alarm tags are not present, CW alarms are not created.
     * WARNING threshold num | CRITICAL threshold num | duration time num | duration periods num
     * example for standard CloudWatch Alarms: "90|95|60|2"
     * example for Anomaly Detection: "90|60|2|ANOMALY_DETECTION"
     */
    const ec2tagRule = new Rule(this, 'TagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['ec2', 'ecs', 'rds'],
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'TagRule'})
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'Ec2Rule'})
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
          service: ['elasticloadbalancing'],
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AlbTagRule'})
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'AlbRule'})
    );

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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'TargetGroupTagRule'})
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'TargetGroupRule'})
    );

    // Rule for OpenSearch tag changes
    const openSearchTagRule = new Rule(this, 'OpenSearchTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['es'],
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'OpenSearchTagRule'})
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'SqsRule'})
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'OpenSearchRule'})
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'TransitGatewayRule'})
    );

    // Rule for Transit Gateway Tag changes
    const transitGatewayTagRule = new Rule(this, 'TransitGatewayTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['ec2'],
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'TransitGatewayTagRule'})
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'Route53ResolverRule'})
    );

    // Rule for Route53Resolver tag changes
    const route53ResolverTagRule = new Rule(this, 'Route53ResolverTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['route53resolver'],
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'Route53ResolverTagRule'})
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'VPNRule'})
    );

    // Rule for VPN tag changes
    const vpnTagRule = new Rule(this, 'VPNTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['ec2'],
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'VPNTagRule'})
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'CloudFrontRule'})
    );

    // Rule for CloudFront tag changes
    const cloudFrontTagRule = new Rule(this, 'CloudFrontTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['cloudfront'],
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
      new SqsQueue(autoAlarmQueue, {messageGroupId: 'CloudFrontTagRule'})
    );
  }
}
