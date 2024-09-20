import {Construct} from 'constructs';
import {MainFunction} from './main-function';
import {ExtendedQueue, ExtendedQueueProps} from 'truemark-cdk-lib/aws-sqs';
import {Rule} from 'aws-cdk-lib/aws-events';
import {SqsQueue} from 'aws-cdk-lib/aws-events-targets';
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

    // Attach policies for autoAlarmQueue.fifo
    lambdaExecutionRole.addToPolicy(
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
          'cloudwatch:PutAnomalyDetector',
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
      visibilityTimeout: Duration.seconds(900), // Set visibility timeout to 15 minutes to match main function timeout
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
  }
}
