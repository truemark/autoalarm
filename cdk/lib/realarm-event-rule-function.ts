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
import {Rule} from 'aws-cdk-lib/aws-events';
import {SqsQueue} from 'aws-cdk-lib/aws-events-targets';

export class ReAlarmTagEventHandler extends Construct {
  public readonly lambdaFunction: ExtendedNodejsFunction;
  public readonly reAlarmTagEventQueue: ExtendedQueue;

  constructor(
    scope: Construct,
    id: string,
    region: string,
    accountId: string,
    reAlarmProducerFuncionArn: string,
  ) {
    super(scope, id);
    /**
     * Create all the required Queues for the ReAlarm tag event handler function
     */
    const queues = this.createQueues();
    this.reAlarmTagEventQueue = queues.reAlarmTagEventQueue;

    /**
     * Set up the IAM role and policies for the ReAlarm Tag Event function
     */
    const role = this.createRole(
      region,
      accountId,
      queues.reAlarmTagEventQueue.queueArn,
    );

    /**
     * Create the ReAlarm Event Rule function
     */
    this.lambdaFunction = this.initializeReAlarmTagEventFunction(
      role,
      reAlarmProducerFuncionArn,
    );

    /**
     * Add tag event queue as event source for the ReAlarm Tag Event function
     */
    this.lambdaFunction.addEventSource(
      new SqsEventSource(queues.reAlarmTagEventQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    /**
     * Set up the EventBridge rule to target the ReAlarm Tag Event queue
     */
    this.createEventBridgeRules();
  }

  /**
   * private method to create Fifo Queues for the ReAlarm Tag Event Handler
   */
  private createQueues(): {
    reAlarmTagEventQueue: ExtendedQueue;
    reAlarmTagEventDLQ: ExtendedQueue;
  } {
    const reAlarmTagEventHandlerDLQ = new ExtendedQueue(
      this,
      'ReAlarmTagEventHandler-Failed',
      {
        fifo: true,
        retentionPeriod: Duration.days(14),
      },
    );

    const reAlarmTagEventHandlerQueue = new ExtendedQueue(
      this,
      'ReAlarmTagEventHandlerQueue',
      {
        fifo: true,
        contentBasedDeduplication: true,
        retentionPeriod: Duration.days(14),
        visibilityTimeout: Duration.seconds(900),
        deadLetterQueue: {queue: reAlarmTagEventHandlerDLQ, maxReceiveCount: 3},
      },
    );
    return {
      reAlarmTagEventQueue: reAlarmTagEventHandlerQueue,
      reAlarmTagEventDLQ: reAlarmTagEventHandlerDLQ,
    };
  }

  /**
   * Private method to set up the IAM role and policies for the ReAlarm Event Rule function
   */
  private createRole(
    region: string,
    accountId: string,
    queueArn: string,
  ): IRole {
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
        resources: [queueArn],
      }),
    );

    return reAlarmEventRuleLambdaExecutionRole;
  }

  /**
   *  private method initialize the ReAlarm Event Rule function
   */
  private initializeReAlarmTagEventFunction(
    role: IRole,
    reAlarmProducerQueueArn: string,
  ): ExtendedNodejsFunction {
    return new ExtendedNodejsFunction(this, 'ReAlarmTagEventFunction', {
      entry: path.join(
        __dirname,
        '..',
        '..',
        'handlers',
        'src',
        'realarm-event-rule-handler.mts',
      ),
      architecture: Architecture.ARM_64,
      handler: 'handler',
      timeout: Duration.minutes(15),
      memorySize: 768,
      role: role,
      environment: {
        PRODUCER_FUNCTION_ARN: reAlarmProducerQueueArn,
      },
      deploymentOptions: {
        createDeployment: false,
      },
    });
  }

  /**
   * private method to create eventbridge rule and set reAlarmTagEventQueue as target
   */
  private createEventBridgeRules(): void {
    const reAlarmEventTagRule = new Rule(this, 'ReAlarmEventTagRule', {
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
    });

    reAlarmEventTagRule.addTarget(
      new SqsQueue(this.reAlarmTagEventQueue, {
        messageGroupId: 'ReAlarmTagEventHandler',
      }),
    );
  }
}
