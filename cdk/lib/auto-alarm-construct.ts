import {Construct} from 'constructs';
import {AutoAlarm} from './main-function-subsconstruct';
import {ReAlarmProducer} from './realarm-producer-subconstruct';
import {ReAlarmConsumer} from './realarm-consumer-subconstruct';
import {Stack} from 'aws-cdk-lib';
import {ReAlarmTagEventHandler} from './realarm-tag-event-subconstruct';
import {EventRules} from './service-eventbridge-subconstruct';
import {SqsHandlerSubConstruct} from './sqs-handler-subconstruct';
import {OamSinkSubConstruct} from './oam-sink-subconstruct';
import {EnrichmentSubConstruct} from './enrichment-subconstruct';
import {SourceAccountStackSetSubConstruct} from './source-account-stackset-subconstruct';

interface AutoAlarmConstructProps {
  readonly prometheusWorkspaceId?: string;
  readonly enableReAlarm?: boolean;
  // OAM Sink
  readonly enableOamSink?: boolean;
  readonly oamSourceAccountIds?: string[];
  readonly oamOrganizationIds?: string[];
  readonly oamResourceTypes?: string[];
  // Enrichment
  readonly enableEnrichment?: boolean;
  readonly enrichmentSourceAccountIds?: string[];
  readonly enrichmentOrganizationIds?: string[];
  readonly enableAgentEnrichment?: boolean;
  readonly agentRuntimeArn?: string;
  readonly agentSeverityFilter?: string[];
  // Source account StackSet
  readonly enableSourceAccountStackSet?: boolean;
  readonly stackSetTargetOuIds?: string[];
  readonly stackSetTargetAccountIds?: string[];
  readonly stackSetDeploymentRegions?: string[];
  readonly stackSetLogGroupFilter?: string;
  readonly stackSetPermissionModel?: 'SERVICE_MANAGED' | 'SELF_MANAGED';
}

export class AutoAlarmConstruct extends Construct {
  protected readonly autoAlarm: AutoAlarm;
  protected readonly sqsHandler: SqsHandlerSubConstruct;
  protected readonly reAlarmProducer: ReAlarmProducer;
  protected readonly reAlarmConsumer: ReAlarmConsumer;
  protected readonly reAlarmTagEventHandler: ReAlarmTagEventHandler;
  protected readonly eventBridgeRules: EventRules;
  protected readonly oamSink: OamSinkSubConstruct;
  protected readonly enrichment: EnrichmentSubConstruct;
  protected readonly sourceAccountStackSet: SourceAccountStackSetSubConstruct;
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
     * Create the SQS handler function and all the source queues for each service AutoAlarm supports.
     * Grant send messages to the mainFunction queue.
     */
    this.sqsHandler = new SqsHandlerSubConstruct(
      this,
      'SqsHandler',
      this.autoAlarm.mainFunctionQueue.queueArn,
      this.autoAlarm.mainFunctionQueue.queueUrl,
    );

    this.autoAlarm.mainFunctionQueue.grantSendMessages(
      this.sqsHandler.lambdaFunction,
    );

    /**
     * Create the EventBridge rules for each service and set the proper queue as the target for each rule
     */
    this.eventBridgeRules = new EventRules(
      this,
      'ServiceEventRules',
      this.sqsHandler.eventSourceQueues,
    );

    /**
     * If OAM Sink is enabled, create the OAM Sink subconstruct.
     * This creates an Observability Access Manager sink that source accounts
     * can link to for cross-account metric and log sharing.
     */
    const enableOamSink = props.enableOamSink ?? false;
    if (enableOamSink) {
      this.oamSink = new OamSinkSubConstruct(this, 'OamSink', {
        sourceAccountIds: props.oamSourceAccountIds,
        organizationIds: props.oamOrganizationIds,
        resourceTypes: props.oamResourceTypes,
      });
    }

    /**
     * If enrichment is enabled, create the enrichment pipeline subconstruct.
     * This creates a custom EventBridge bus, SQS queue, enrichment Lambda,
     * SNS topic, and DynamoDB idempotency table for alarm enrichment.
     */
    const enableEnrichment = props.enableEnrichment ?? false;
    if (enableEnrichment) {
      this.enrichment = new EnrichmentSubConstruct(this, 'Enrichment', {
        sourceAccountIds: props.enrichmentSourceAccountIds,
        organizationIds: props.enrichmentOrganizationIds,
        enableAgentEnrichment: props.enableAgentEnrichment,
        agentRuntimeArn: props.agentRuntimeArn,
        agentSeverityFilter: props.agentSeverityFilter,
      });
    }

    /**
     * If source account StackSet is enabled, deploy the OAM Link + EventBridge
     * forwarding rule to target OUs via CloudFormation StackSets.
     *
     * Requires enrichment to be enabled (for the hub event bus ARN).
     * Requires the hub account to be the org management account or a delegated
     * CloudFormation StackSets administrator.
     */
    const enableSourceAccountStackSet =
      props.enableSourceAccountStackSet ?? false;
    if (enableSourceAccountStackSet && this.enrichment) {
      this.sourceAccountStackSet = new SourceAccountStackSetSubConstruct(
        this,
        'SourceAccountStackSet',
        {
          // Construct ARN manually to avoid circular CDK token dependency
          // (bus name is deterministic: 'AutoAlarm-Central')
          hubEventBusArn: `arn:aws:events:${region}:${accountId}:event-bus/AutoAlarm-Central`,
          sinkArn: this.oamSink?.sinkArn,
          targetOrganizationalUnitIds: props.stackSetTargetOuIds,
          targetAccountIds: props.stackSetTargetAccountIds,
          deploymentRegions: props.stackSetDeploymentRegions,
          oamResourceTypes: props.oamResourceTypes,
          logGroupFilter: props.stackSetLogGroupFilter,
          permissionModel: props.stackSetPermissionModel,
        },
      );
    }
  }
}
