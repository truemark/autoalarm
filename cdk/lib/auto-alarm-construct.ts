/**
 * TODO: Build DyunamoDB table to store alarm state
 */
import {Construct} from 'constructs';
import {AutoAlarm} from './main-function-subsconstruct';
import {ReAlarmProducer} from './realarm-producer-subconstruct';
import {ReAlarmConsumer} from './realarm-consumer-subconstruct';
import {Stack} from 'aws-cdk-lib';
import {ReAlarmTagEventHandler} from './realarm-tag-event-subconstruct';
import {EventRules} from './service-eventbridge-subconstruct';

interface AutoAlarmConstructProps {
  readonly prometheusWorkspaceId?: string;
  readonly enableReAlarm?: boolean;
}

export class AutoAlarmConstruct extends Construct {
  protected readonly autoAlarm: AutoAlarm;
  protected readonly reAlarmProducer: ReAlarmProducer;
  protected readonly reAlarmConsumer: ReAlarmConsumer;
  protected readonly reAlarmTagEventHandler: ReAlarmTagEventHandler;
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
       * If reAlarm is enabled, create the ReAlarm Consumer, Producer and tag event handler objects
       * Each of these objects contain all resources for each lambda: function, role, queue, and event rules (where applicable)
       * ---------------------
       * 1. ReAlarm Consumer: Consume from Consumer Queue, and resets alarms.
       * 2. ReAlarm Producer: Consume from Producer Queue, grabs all alarms, applies pre-filtering and routes to consumer queue.
       * 3. ReAlarm Tag Event Handler: Creates/deletes EventBridge rules for ReAlarm custom schedule tag changes.
       */
      this.reAlarmConsumer = new ReAlarmConsumer(this, 'ReAlarmConsumer');

      this.reAlarmProducer = new ReAlarmProducer(
        this,
        'ReAlarmProducer',
        region,
        accountId,
        this.reAlarmConsumer.reAlarmConsumerQueue.queueArn,
        this.reAlarmConsumer.reAlarmConsumerQueue.queueUrl,
      );

      this.reAlarmTagEventHandler = new ReAlarmTagEventHandler(
        this,
        'ReAlarmTagHandler',
        region,
        accountId,
        this.reAlarmProducer.lambdaFunction.functionArn,
      );

      /**
       * Allow reAlarm tag event handler lambda function to consume messages from the event rule queue
       * Allow the producer to send messages to the consumer queue
       * Allow the consumer to consume messages from the consumer queue
       * Add the consumer function as an event source for the consumer queue
       * Store Producer function ARN for use in Event Rule Lambda function
       */
      this.reAlarmTagEventHandler.reAlarmTagEventQueue.grantConsumeMessages(
        this.reAlarmTagEventHandler.lambdaFunction,
      );
      this.reAlarmConsumer.reAlarmConsumerQueue.grantSendMessages(
        this.reAlarmProducer.lambdaFunction,
      );
      this.reAlarmConsumer.reAlarmConsumerQueue.grantConsumeMessages(
        this.reAlarmConsumer.lambdaFunction,
      );
    }

    /**
     * Create the MainFunction, mainfunction queue and associated resources
     */
    this.autoAlarm = new AutoAlarm(
      this,
      'MainHandler',
      region,
      accountId,
      prometheusArn,
      prometheusWorkspaceId,
    );

    /**
     * Create the EventBridge rules for each service and set the proper queue as the target for each rule
     */
    this.eventBridgeRules = new EventRules(
      this,
      'ServiceEventRules',
      this.autoAlarm.lambdaFunction,
    );
  }
}
