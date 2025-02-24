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
import {Rule, Schedule} from 'aws-cdk-lib/aws-events';
import {LambdaFunction} from 'aws-cdk-lib/aws-events-targets';

export class ReAlarmProducer extends Construct {
  public readonly lambdaFunction: ExtendedNodejsFunction;
  constructor(
    scope: Construct,
    id: string,
    region: string,
    accountId: string,
    reAlarmConsumerQueueArn: string,
    reAlarmConsumerQueueURL: string,
  ) {
    super(scope, id);
    /**
     * Set up the IAM role and policies for the ReAlarm Producer function
     * @param reAlarmConsumerQueueArn - The ARN of the reAlarm consumer queue used to grant permissions to the producer to send messages to the consumer queue
     */
    const role = this.createRole(reAlarmConsumerQueueArn);

    /**
     * Expose the ReAlarm Producer queue for use in across the stack
     */

    /**
     * Initialize the ReAlarm Producer function
     * @param role - The IAM role for the ReAlarm Producer function
     * @param reAlarmConsumerQueueURL - The URL of the reAlarm consumer queue to be passed as an environment variable
     */
    this.lambdaFunction = this.createFunction(role, reAlarmConsumerQueueURL);

    /**
     * grant eventbridge permissions to trigger the producer function
     */
    this.lambdaFunction.addPermission('EventBridgePermission', {
      principal: new ServicePrincipal('events.amazonaws.com'),
      sourceArn: `arn:aws:events:${region}:${accountId}:rule/AutoAlarm-ReAlarm-*`,
    });

    /**
     * Set up the EventBridge rule to trigger the ReAlarm Producer function
     */
    this.createEventBridgeRules();
  }

  /**
   * Private method to:
   * Set up the IAM role/policies for the ReAlarm Producer function
   * Allow the producer to describe alarms and list tags
   * Allow the producer to send messages to the consumer queue
   * Allow the producer to write to CloudWatch Logs
   * @param reAlarmConsumerQueueArn - The ARN of the reAlarm consumer queue used to send messages to consuemr lambda
   */
  private createRole(reAlarmConsumerQueueArn: string): IRole {
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
        actions: ['sqs:SendMessage', 'sqs:SendMessageBatch', 'sqs:GetQueueUrl'],
        resources: [reAlarmConsumerQueueArn],
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

    return reAlarmProducerRole;
  }

  /**
   * private method to up the EventBridge rule to trigger the ReAlarm Producer function
   */
  private createEventBridgeRules(): void {
    const reAlarmeScheduleRule = new Rule(this, 'ReAlarmScheduleRule', {
      schedule: Schedule.rate(Duration.minutes(120)),
      description:
        'Default rule to trigger the ReAlarm Producer function every 2 hours',
    });

    // add target to rule
    reAlarmeScheduleRule.addTarget(new LambdaFunction(this.lambdaFunction));
  }

  /**
   * Private method to create the ReAlarm Producer function
   * @param role - The IAM role for the ReAlarm Producer function
   * @param consumerQueueURL - The URL of the reAlarm consumer queue to be passed as an environment variable
   */
  private createFunction(
    role: IRole,
    consumerQueueURL: string,
  ): ExtendedNodejsFunction {
    return new ExtendedNodejsFunction(this, 'ReAlarmProducerFunction', {
      entry: path.join(
        __dirname,
        '..',
        '..',
        'handlers',
        'src',
        'realarm-producer-handler.mts',
      ),
      architecture: Architecture.ARM_64,
      handler: 'handler',
      timeout: Duration.minutes(15),
      memorySize: 768,
      role: role,
      environment: {
        CONSUMER_QUEUE_URL: consumerQueueURL,
      },
      deploymentOptions: {
        createDeployment: false,
      },
      bundling: {
        nodeModules: ['@smithy/util-retry'],
      },
    });
  }
}
