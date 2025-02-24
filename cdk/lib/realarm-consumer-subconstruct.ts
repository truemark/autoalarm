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

export class ReAlarmConsumer extends Construct {
  public readonly labmdaFunction: ExtendedNodejsFunction;
  public readonly reAlarmConsumerFunctionArn: string;
  public readonly reAlarmConsumerQueue: ExtendedQueue;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    /**
     * Create the ReAlarm Consumer queue and expose it for use across the stack
     */
    const queues = this.createQueues();
    this.reAlarmConsumerQueue = queues.consumerQueue;

    /**
     * Set up the IAM role and policies for the ReAlarm Consumer function
     *
     */
    const role = this.createRole(this.reAlarmConsumerQueue.queueArn);

    /**
     * Create the ReAlarm Consumer function
     * @param role - The IAM role for the ReAlarm Consumer function
     */
    this.labmdaFunction = this.initializeReAlarmConsumerFunction(role);

    /**
     * Set the ARN of the ReAlarm Consumer function and expose it for use across the stack
     */
    this.reAlarmConsumerFunctionArn = this.labmdaFunction.functionArn;

    /**
     * Add consumer queue as event source for the consumer function
     */
    this.labmdaFunction.addEventSource(
      new SqsEventSource(this.reAlarmConsumerQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );
  }

  /**
   * private method to create the ReAlarm Consumer queue and DLQ
   */
  private createQueues(): {
    consumerQueue: ExtendedQueue;
    consumerDLQ: ExtendedQueue;
  } {
    const reAlarmConsumerDLQ = new ExtendedQueue(
      this,
      'reAlarmConsumerQueue-Failed',
      {
        fifo: true,
        retentionPeriod: Duration.days(14),
      },
    );

    const reAlarmConsumerQueue = new ExtendedQueue(
      this,
      'reAlarmConsumerQueue',
      {
        fifo: true,
        contentBasedDeduplication: true,
        retentionPeriod: Duration.days(14),
        visibilityTimeout: Duration.seconds(60),
        deadLetterQueue: {queue: reAlarmConsumerDLQ, maxReceiveCount: 3},
      },
    );
    return {
      consumerQueue: reAlarmConsumerQueue,
      consumerDLQ: reAlarmConsumerDLQ,
    };
  }

  /**
   * private method to create the IAM role for the ReAlarm Consumer function
   */
  private createRole(reAlarmConsumerQueueArn: string): IRole {
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
        resources: [reAlarmConsumerQueueArn],
      }),
    );

    return reAlarmConsumerRole;
  }

  /**
   * private method initialize the ReAlarm Consumer function
   */
  private initializeReAlarmConsumerFunction(
    role: IRole,
  ): ExtendedNodejsFunction {
    // Create the ReAlarm Consumer function
    return new ExtendedNodejsFunction(this, 'ReAlarmConsumerFunction', {
      entry: path.join(
        __dirname,
        '..',
        '..',
        'handlers',
        'src',
        'realarm-consumer-handler.mts',
      ),
      architecture: Architecture.ARM_64,
      handler: 'handler',
      timeout: Duration.minutes(15),
      memorySize: 768,
      role: role,
      deploymentOptions: {
        createDeployment: false,
      },
      bundling: {
        nodeModules: ['@smithy/util-retry'],
      },
    });
  }

  /**
   * private method to up the EventBridge rule to trigger the ReAlarm Consumer function
   */
}
