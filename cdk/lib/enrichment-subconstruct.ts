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
import {Duration, RemovalPolicy, Stack} from 'aws-cdk-lib';
import {Architecture} from 'aws-cdk-lib/aws-lambda';
import {SqsEventSource} from 'aws-cdk-lib/aws-lambda-event-sources';
import {NoBreachingExtendedQueue} from './extended-libs-subconstruct';
import {EventBus, Rule} from 'aws-cdk-lib/aws-events';
import {SqsQueue} from 'aws-cdk-lib/aws-events-targets';
import {Topic} from 'aws-cdk-lib/aws-sns';
import {Alias} from 'aws-cdk-lib/aws-kms';
import {
  Table,
  AttributeType,
  BillingMode,
  TableEncryption,
} from 'aws-cdk-lib/aws-dynamodb';
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';

export interface EnrichmentSubConstructProps {
  /**
   * Source account IDs allowed to PutEvents to the central event bus.
   */
  readonly sourceAccountIds?: string[];

  /**
   * Organization IDs whose accounts can PutEvents to the central bus.
   */
  readonly organizationIds?: string[];

  /**
   * Enable Bedrock AgentCore agent invocation for incident summarization.
   */
  readonly enableAgentEnrichment?: boolean;

  /**
   * Bedrock AgentCore Runtime ARN for agent invocation.
   */
  readonly agentRuntimeArn?: string;

  /**
   * Alarm severities that trigger agent invocation. Default: ['Critical']
   */
  readonly agentSeverityFilter?: string[];
}

export class EnrichmentSubConstruct extends Construct {
  public readonly lambdaFunction: ExtendedNodejsFunction;
  public readonly enrichmentQueue: NoBreachingExtendedQueue;
  public readonly enrichmentDlq: NoBreachingExtendedQueue;
  public readonly centralEventBus: EventBus;
  public readonly enrichedAlarmsTopic: Topic;
  public readonly idempotencyTable: Table;

  constructor(
    scope: Construct,
    id: string,
    props: EnrichmentSubConstructProps,
  ) {
    super(scope, id);

    const region = Stack.of(this).region;
    const accountId = Stack.of(this).account;

    // 1. Custom EventBridge bus for cross-account alarm events
    this.centralEventBus = this.createCentralEventBus(
      props.sourceAccountIds,
      props.organizationIds,
      accountId,
    );

    // 2. SNS topic for enriched alarm output (encrypted with AWS-managed SNS key)
    this.enrichedAlarmsTopic = new Topic(this, 'EnrichedAlarmsTopic', {
      topicName: 'AutoAlarm-EnrichedAlarms',
      displayName: 'AutoAlarm Enriched Alarm Events',
      masterKey: Alias.fromAliasName(this, 'SnsKey', 'alias/aws/sns'),
    });

    // 3. DynamoDB idempotency table
    this.idempotencyTable = new Table(this, 'IdempotencyTable', {
      tableName: 'AutoAlarm-Enrichment-Idempotency',
      partitionKey: {name: 'idempotencyKey', type: AttributeType.STRING},
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 4. IAM role for enrichment Lambda
    const role = this.createRole(
      region,
      accountId,
      this.enrichedAlarmsTopic.topicArn,
      this.idempotencyTable.tableArn,
      props.enableAgentEnrichment,
      props.agentRuntimeArn,
    );

    // 5. Enrichment Lambda
    this.lambdaFunction = this.createFunction(
      role,
      region,
      this.enrichedAlarmsTopic.topicArn,
      this.idempotencyTable.tableName,
      props.enableAgentEnrichment,
      props.agentRuntimeArn,
      props.agentSeverityFilter,
    );

    // 6. Enrichment SQS queue + DLQ
    const {queue, dlq} = this.createEnrichmentQueue();
    this.enrichmentQueue = queue;
    this.enrichmentDlq = dlq;

    // 7. CloudWatch alarms on DLQ depth and queue age
    this.createQueueAlarms();

    // 8. EventBridge rule: alarm state changes → enrichment queue
    this.createAlarmStateChangeRule();
  }

  private createCentralEventBus(
    sourceAccountIds?: string[],
    organizationIds?: string[],
    accountId?: string,
  ): EventBus {
    const busName = 'AutoAlarm-Central';
    const bus = new EventBus(this, 'CentralEventBus', {
      eventBusName: busName,
    });

    // Construct the bus ARN as a plain string to avoid CDK token
    // self-references that cause circular dependency errors.
    const region = Stack.of(this).region;
    const busArn = `arn:aws:events:${region}:${accountId}:event-bus/${busName}`;

    // Build resource policy statements for cross-account PutEvents
    const policyStatements: object[] = [];

    if (sourceAccountIds && sourceAccountIds.length > 0) {
      policyStatements.push({
        Sid: 'AllowSourceAccountsPutEvents',
        Effect: 'Allow',
        Principal: {
          AWS: sourceAccountIds.map((id) => `arn:aws:iam::${id}:root`),
        },
        Action: 'events:PutEvents',
        Resource: busArn,
      });
    }

    if (organizationIds && organizationIds.length > 0) {
      policyStatements.push({
        Sid: 'AllowOrganizationPutEvents',
        Effect: 'Allow',
        Principal: '*',
        Action: 'events:PutEvents',
        Resource: busArn,
        Condition: {
          StringEquals: {
            'aws:PrincipalOrgID': organizationIds,
          },
        },
      });
    }

    // Allow same-account events
    if (accountId) {
      policyStatements.push({
        Sid: 'AllowSameAccountPutEvents',
        Effect: 'Allow',
        Principal: {
          AWS: `arn:aws:iam::${accountId}:root`,
        },
        Action: 'events:PutEvents',
        Resource: busArn,
      });
    }

    if (policyStatements.length > 0) {
      const cfnBus = bus.node.defaultChild as import('aws-cdk-lib/aws-events').CfnEventBus;
      cfnBus.addPropertyOverride('Policy', {
        Version: '2012-10-17',
        Statement: policyStatements,
      });
    }

    return bus;
  }

  private createEnrichmentQueue(): {
    queue: NoBreachingExtendedQueue;
    dlq: NoBreachingExtendedQueue;
  } {
    const dlq = new NoBreachingExtendedQueue(
      this,
      'Enrichment-DLQ',
      'Enrichment',
      {
        fifo: true,
        retentionPeriod: Duration.days(14),
      },
    );

    const queue = new NoBreachingExtendedQueue(
      this,
      'Enrichment-Queue',
      'Enrichment',
      {
        fifo: true,
        contentBasedDeduplication: true,
        retentionPeriod: Duration.days(4),
        visibilityTimeout: Duration.seconds(90),
        deadLetterQueue: {queue: dlq, maxReceiveCount: 3},
      },
    );

    queue.grantConsumeMessages(this.lambdaFunction);
    this.lambdaFunction.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 1,
        reportBatchItemFailures: true,
        enabled: true,
      }),
    );

    return {queue, dlq};
  }

  private createQueueAlarms(): void {
    // DLQ depth: any message in the DLQ means a failed enrichment — warn immediately
    new Alarm(this, 'DlqDepthWarning', {
      metric: this.enrichmentDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmName: 'Enrichment-DLQ-Depth-Warning',
      alarmDescription:
        'One or more enrichment events failed all retries and landed in the DLQ.',
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new Alarm(this, 'DlqDepthCritical', {
      metric: this.enrichmentDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
      }),
      threshold: 50,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmName: 'Enrichment-DLQ-Depth-Critical',
      alarmDescription:
        'Large number of enrichment events in DLQ — possible systemic failure.',
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // Queue age: backlog is building — enrichment is falling behind
    new Alarm(this, 'QueueAgeWarning', {
      metric: this.enrichmentQueue.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(1),
      }),
      threshold: 300, // 5 minutes
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmName: 'Enrichment-Queue-Age-Warning',
      alarmDescription:
        'Enrichment queue backlog is growing — oldest message over 5 minutes old.',
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new Alarm(this, 'QueueAgeCritical', {
      metric: this.enrichmentQueue.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(1),
      }),
      threshold: 900, // 15 minutes
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmName: 'Enrichment-Queue-Age-Critical',
      alarmDescription:
        'Enrichment queue severely backlogged — circuit breaker may activate.',
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }

  private createAlarmStateChangeRule(): void {
    new Rule(this, 'AlarmStateChangeRule', {
      eventBus: this.centralEventBus,
      description:
        'Routes AutoAlarm alarm state changes to the enrichment queue',
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        detail: {
          alarmName: [{prefix: 'AutoAlarm-'}],
          state: {value: ['ALARM']},
          previousState: {value: ['OK', 'INSUFFICIENT_DATA']},
        },
      },
      targets: [
        new SqsQueue(this.enrichmentQueue, {
          messageGroupId: 'enrichment',
        }),
      ],
    });
  }

  private createRole(
    region: string,
    accountId: string,
    snsTopicArn: string,
    dynamoTableArn: string,
    enableAgentEnrichment?: boolean,
    agentRuntimeArn?: string,
  ): IRole {
    const role = new Role(this, 'EnrichmentLambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for AutoAlarm Enrichment Lambda function',
    });

    // CloudWatch Logs (own logs)
    role.addToPolicy(
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

    // CloudWatch read (cross-account via OAM)
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'cloudwatch:GetMetricData',
          'cloudwatch:ListMetrics',
          'cloudwatch:DescribeAlarms',
          'cloudwatch:ListTagsForResource',
        ],
        resources: ['*'],
      }),
    );

    // CloudWatch Logs read (cross-account via OAM)
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'logs:StartQuery',
          'logs:GetQueryResults',
          'logs:StopQuery',
          'logs:DescribeLogGroups',
        ],
        resources: ['*'],
      }),
    );

    // OAM read
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['oam:Get*', 'oam:List*'],
        resources: ['*'],
      }),
    );

    // CloudTrail read
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['cloudtrail:LookupEvents'],
        resources: ['*'],
      }),
    );

    // SNS publish
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['sns:Publish'],
        resources: [snsTopicArn],
      }),
    );

    // DynamoDB (idempotency table)
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:DeleteItem',
        ],
        resources: [dynamoTableArn],
      }),
    );

    // CloudWatch custom metrics (enrichment observability)
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      }),
    );

    // Resource tag reading (for enrichment context)
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'ec2:DescribeInstances',
          'ec2:DescribeTags',
          'rds:DescribeDBInstances',
          'rds:ListTagsForResource',
          'rds:DescribeDBClusters',
          'elasticloadbalancing:DescribeTags',
          'elasticloadbalancing:DescribeLoadBalancers',
          'elasticloadbalancing:DescribeTargetGroups',
          'sqs:ListQueueTags',
          'sqs:GetQueueAttributes',
          'es:ListTags',
          'es:DescribeElasticsearchDomain',
          'ecs:DescribeServices',
          'ecs:ListTagsForResource',
          'states:ListTagsForResource',
          'cloudfront:ListTagsForResource',
          'route53resolver:ListTagsForResource',
          'ec2:DescribeTransitGateways',
          'ec2:DescribeVpnConnections',
        ],
        resources: ['*'],
      }),
    );

    // Optional: Bedrock AgentCore invocation
    if (enableAgentEnrichment && agentRuntimeArn) {
      role.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock-agentcore:InvokeAgentRuntime'],
          resources: [agentRuntimeArn],
        }),
      );
    }

    return role;
  }

  private createFunction(
    role: IRole,
    region: string,
    snsTopicArn: string,
    dynamoTableName: string,
    enableAgentEnrichment?: boolean,
    agentRuntimeArn?: string,
    agentSeverityFilter?: string[],
  ): ExtendedNodejsFunction {
    return new ExtendedNodejsFunction(this, 'EnrichmentFunction', {
      entry: path.join(
        __dirname,
        '..',
        '..',
        'handlers',
        'src',
        'enrichment-handler.mts',
      ),
      architecture: Architecture.ARM_64,
      handler: 'handler',
      timeout: Duration.seconds(60),
      memorySize: 768,
      reservedConcurrentExecutions: 50,
      role: role,
      environment: {
        REGION: region,
        SNS_TOPIC_ARN: snsTopicArn,
        IDEMPOTENCY_TABLE_NAME: dynamoTableName,
        AGENT_ENABLED: enableAgentEnrichment ? 'true' : 'false',
        AGENT_RUNTIME_ARN: agentRuntimeArn ?? '',
        AGENT_SEVERITY_FILTER: JSON.stringify(
          agentSeverityFilter ?? ['Critical'],
        ),
        DASHBOARD_TEMPLATES: JSON.stringify({}),
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
