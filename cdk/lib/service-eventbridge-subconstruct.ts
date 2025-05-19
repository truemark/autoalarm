import {Construct} from 'constructs';
import {Rule} from 'aws-cdk-lib/aws-events';
import {SqsQueue} from 'aws-cdk-lib/aws-events-targets';
import {NoBreachingExtendedQueue} from './extended-libs-subconstruct';
import {ExtendedNodejsFunction} from 'truemark-cdk-lib/aws-lambda';
import {Duration} from 'aws-cdk-lib';
import {SqsEventSource} from 'aws-cdk-lib/aws-lambda-event-sources';

export class EventRules extends Construct {
  private globalTagRule: Rule;
  private sqsTagRule: Rule;
  private globalCreateDeleteRule: Rule;

  constructor(
    scope: Construct,
    id: string,
    lambdaFunction: ExtendedNodejsFunction,
  ) {
    super(scope, id);
    this.initializeServiceEventRules(); // Create the rules
    this.eventRuleTargetSetter(lambdaFunction); // Add targets
  }

  private initializeServiceEventRules() {
    this.globalTagRule = new Rule(this, 'GlobalTagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          // This will match any service
          'service': ['*'],
          // This will match any resource type
          'resource-type': ['*'],
          // This uses the prefix-match pattern to catch any tag key starting with "autoalarm:"
          'changed-tag-keys': [{prefix: 'autoalarm:'}],
        },
      },
      description:
        'Routes tag change events for all autoalarm: prefixed tags across all services',
    });

    /**
     * SQS Tag Changes differs in pattern from the rest of the services. Create a separate rule for it because it's special.
     */
    this.sqsTagRule = new Rule(this, 'SqsTagRule', {
      eventPattern: {
        source: ['aws.sqs'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          'eventSource': ['sqs.amazonaws.com'],
          'eventName': ['Tag*', 'Untag*'],
          'changed-tag-keys': [{prefix: 'autoalarm:'}],
        },
      },
      description: 'Routes tag change events for SQS',
    });

    /**
     * Create Global Create/Delete Event Rule
     */
    this.globalCreateDeleteRule = new Rule(this, 'GlobalCreateDeleteRule', {
      eventPattern: {
        source: ['*'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['*'],
          eventName: ['Create*', 'Delete*', 'running', 'terminated'],
        },
      },
      description: 'Routes create/delete events',
    });
  }

  /**
   * Private method to create a dlq and a fifo for the event type,
   * Set the event target to the fifo queue
   * Grant the lambda function permission to consume the queue
   * And set the event source to the lambda function
   *
   * @param lambdaFunction Lambda Function to grant consume to
   */
  private eventRuleTargetSetter(lambdaFunction: ExtendedNodejsFunction): void {
    const addQueues = (rule: Rule, queueName: string) => {
      const dlq = new NoBreachingExtendedQueue(
        this,
        queueName.replace('AutoAlarm-', '') + '-Failed',
        queueName,
        {
          fifo: true,
          retentionPeriod: Duration.days(14),
        },
      );

      const newQueue = new NoBreachingExtendedQueue(
        this,
        queueName.replace('AutoAlarm-', ''),
        queueName,
        {
          fifo: true,
          contentBasedDeduplication: true,
          retentionPeriod: Duration.days(14),
          visibilityTimeout: Duration.seconds(900),
          deadLetterQueue: {queue: dlq, maxReceiveCount: 3},
        },
      );

      rule.addTarget(
        new SqsQueue(newQueue, {
          messageGroupId: `AutoAlarm-${queueName}`,
        }),
      );

      newQueue.grantConsumeMessages(lambdaFunction);
      lambdaFunction.addEventSource(
        new SqsEventSource(newQueue, {
          batchSize: 10,
          reportBatchItemFailures: true,
          enabled: true,
        }),
      );
    };

    for (const queue of [
      'AutoAlarm-GlobalTagRule',
      'AutoAlarm-GlobalCreateDeleteRule',
    ]) {
      if (queue.includes('Tag')) {
        addQueues(this.globalTagRule, queue);
        addQueues(this.sqsTagRule, queue);
      }
      addQueues(this.globalCreateDeleteRule, queue);
    }
  }
}
