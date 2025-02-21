import {Construct} from 'constructs';
import {MainFunction} from './main-function';
import {ReAlarmProducerFunction} from './realarm-producer-function';
import {ReAlarmConsumerFunction} from './realarm-consumer-function';
import {ExtendedQueue, StandardQueue} from 'truemark-cdk-lib/aws-sqs';
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
import {EventRules} from './eventbridge-subconstruct';

export interface AutoAlarmConstructProps {
  readonly prometheusWorkspaceId?: string;
  readonly enableReAlarm?: boolean;
}

export class AutoAlarmConstruct extends Construct {
  protected readonly reAlarmProducerFunctionARN: string;
  protected readonly eventBridgeRules: EventRules;
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
     *
     * Create the MainFunction and associated resources
     * configure the AutoAlarm Function and associated queues and eventbridge rules
     */

    /**
     * Set up the IAM role and policies for the main function
     */
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
        actions: [
          'rds:DescribeDBInstances',
          'rds:ListTagsForResource',
          'rds:DescribeDBClusters',
        ],
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

    /**
     * Create the MainFuncion and associated Queues
     */
    const mainFunction = new MainFunction(this, 'MainFunction', {
      role: mainFunctionExecutionRole, // Pass the role here
      prometheusWorkspaceId: prometheusWorkspaceId,
    });

    /**
     * Create a string array of all the autoAlarmQueue names
     */
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

    /**
     * create a custom object that contains/will contain all our fifo SQS queues.
     */
    const queues: {[key: string]: ExtendedQueue} = {};

    /**
     * Loop through the autoAlarmQueues array and create a new ExtendedQueue object for each queue and add it to queues object
     * Grant consume messages to the mainFunction for each queue
     * Finally add an event source to the mainFunction for each queue
     */
    for (const queueName of autoAlarmQueues) {
      // Create DLQ for each queue and let cdk handle the name generation after the queue name
      const dlq = new ExtendedQueue(this, `${queueName}-failed`, {
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

      queues[queueName].grantConsumeMessages(mainFunction);
      mainFunction.addEventSource(
        new SqsEventSource(queues[queueName], {
          batchSize: 10,
          reportBatchItemFailures: true,
          enabled: true,
        }),
      );
    }

    /**
     * Create the EventBridge rules for each queue
     */
    this.eventBridgeRules = new EventRules(
      this,
      'EventBridgeRules',
      accountId,
      region,
    );

    /**
     * Set the targets for each EventBridgeRule rule
     */
    this.eventRuleTargetSetter(this.eventBridgeRules, queues);
  }

  /**
   * Helper function to dynamically grab each queue and create messageID and add it as a target for our event bridge rules.
   * using ugly repetition until this is refactored later and this construct is properly built.
   */
  private eventRuleTargetSetter(
    eventBridgeRules: EventRules,
    queues: {[key: string]: ExtendedQueue},
  ): void {
    try {
      for (const serviceName of eventBridgeRules.rules.keys()) {
        // Find queue where the key includes the service name
        const queueKey = Object.keys(queues).find((key) =>
          key.toLowerCase().includes(serviceName.toLowerCase()),
        );

        if (!queueKey) {
          console.warn(
            `No queue found containing service name: ${serviceName}`,
          );
          break;
        }

        const queue = queues[queueKey];
        const serviceRules = eventBridgeRules.rules.get(serviceName);

        if (!serviceRules) {
          console.warn(`No rules found for service: ${serviceName}`);
          break;
        }

        serviceRules.forEach((ruleObj) => {
          Object.values(ruleObj).forEach((rule) => {
            try {
              rule.addTarget(
                new SqsQueue(queue, {
                  messageGroupId: `AutoAlarm-${serviceName}`,
                }),
              );
            } catch (error) {
              console.error(
                `Error adding target for rule in service ${serviceName}:`,
                error,
              );
            }
          });
        });
      }
    } catch (error) {
      console.error('Error in eventRuleTargetSetter:', error);
      throw error;
    }
  }
}
