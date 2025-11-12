import {Construct} from 'constructs';
import {Rule} from 'aws-cdk-lib/aws-events';
import {SqsQueue} from 'aws-cdk-lib/aws-events-targets';
import {NoBreachingExtendedQueue} from './extended-libs-subconstruct';

type ServiceName =
  | 'alb'
  | 'cloudfront'
  | 'ec2'
  | 'ecs'
  | 'opensearch'
  | 'rds'
  | 'rdscluster'
  | 'route53resolver'
  | 'sqs'
  | 'sfn'
  | 'targetgroup'
  | 'transitgateway'
  | 'vpn';

type RuleObject = {
  [ruleName: string]: Rule;
};

export class EventRules extends Construct {
  public readonly serviceRules: Map<ServiceName, RuleObject[]>;

  constructor(
    scope: Construct,
    id: string,
    queues: {[key: string]: NoBreachingExtendedQueue},
  ) {
    super(scope, id);
    this.serviceRules = new Map();
    this.initializeServiceEventRules();
    this.eventRuleTargetSetter(this, queues);
  }

  /**
   * Initialize the rules map with empty arrays for each service
   * Annoyingly, we can't loop through attributes of a type so we have to manually be a bit repetitive here.
   * @private
   */
  private initializeServiceEventRules() {
    const services: ServiceName[] = [
      'alb',
      'cloudfront',
      'ec2',
      'ecs',
      'opensearch',
      'rds',
      'rdscluster',
      'route53resolver',
      'sqs',
      'sfn',
      'targetgroup',
      'transitgateway',
      'vpn',
    ];

    /**
     * Initialize the rules map with empty arrays for each service
     */
    services.forEach((service) => {
      this.serviceRules.set(service, []);
    });

    /**
     * Add rules for each service
     */
    this.addAlbRules();
    this.addCloudFrontRules();
    this.addEc2Rules();
    this.addEcsRules();
    this.addOpenSearchRules();
    this.addRdsRules();
    this.addRdsClusterRules();
    this.addRoute53ResolverRules();
    this.addSqsRules();
    this.addSNFRules();
    this.addTargetGroupRules();
    this.addTransitGatewayRules();
    this.addVpnRules();
  }

  private addAlbRules() {
    const albRules = this.serviceRules.get('alb') || [];

    albRules.push({
      albTagRule: new Rule(this, 'AlbTagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['elasticloadbalancing'],
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
      }),
    });

    albRules.push({
      albStateRule: new Rule(this, 'AlbRule', {
        eventPattern: {
          source: ['aws.elasticloadbalancing'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['elasticloadbalancing.amazonaws.com'],
            eventName: ['CreateLoadBalancer', 'DeleteLoadBalancer'],
          },
        },
        description: 'Routes ALB events to AutoAlarm',
      }),
    });

    this.serviceRules.set('alb', albRules);
  }

  private addCloudFrontRules() {
    const cloudFrontRules = this.serviceRules.get('cloudfront') || [];

    cloudFrontRules.push({
      cloudStateRule: new Rule(this, 'CloudStateRule', {
        eventPattern: {
          source: ['aws.cloudfront'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['cloudfront.amazonaws.com'],
            eventName: ['CreateDistribution', 'DeleteDistribution'],
          },
        },
        description: 'Routes CloudFront events to AutoAlarm',
      }),
    });

    cloudFrontRules.push({
      cloudFrontTagRule: new Rule(this, 'CloudFrontTagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['cloudfront'],
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
      }),
    });

    this.serviceRules.set('cloudfront', cloudFrontRules);
  }

  private addEc2Rules() {
    const ec2Rules = this.serviceRules.get('ec2') || [];
    ec2Rules.push({
      ec2TagRule: new Rule(this, 'ec2TagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['ec2'],
            'resource-type': ['instance'],
            'changed-tag-keys': [
              'autoalarm:enabled',
              'autoalarm:cpu',
              'autoalarm:storage',
              'autoalarm:memory',
              'autoalarm:cpu-anomaly',
              'autoalarm:storage-anomaly',
              'autoalarm:memory-anomaly',
              'autoalarm:target',
              'autoalarm:network-in-anomaly',
              'autoalarm:network-in',
              'autoalarm:network-out-anomaly',
              'autoalarm:network-out',
            ],
          },
        },
        description: 'Routes tag events to AutoAlarm',
      }),
    });

    ec2Rules.push({
      ec2StateRule: new Rule(this, 'Ec2StateRule', {
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
      }),
    });

    this.serviceRules.set('ec2', ec2Rules);
  }

  private addEcsRules() {
    const ecsRules = this.serviceRules.get('ecs') || [];

    ecsRules.push({
      ecsStateRule: new Rule(this, 'EcsStateRule', {
        eventPattern: {
          source: ['aws.ecs'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['ecs.amazonaws.com'],
            eventName: [
              'CreateCluster',
              'DeleteCluster',
              'TagResource',
              'UntagResource',
            ],
          },
        },
        description: 'Routes ECS state change and tag events to AutoAlarm',
      }),
    });
    this.serviceRules.set('ecs', ecsRules);
  }

  private addOpenSearchRules() {
    const openSearchRules = this.serviceRules.get('opensearch') || [];

    openSearchRules.push({
      openSearchTagRule: new Rule(this, 'OpenSearchTagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['es'],
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
              'autoalarm:storage',
              'autoalarm:storage-anomaly',
              'autoalarm:sys-memory-util',
              'autoalarm:sys-memory-util-anomaly',
              'autoalarm:throughput-throttle',
              'autoalarm:throughput-throttle-anomaly',
              'autoalarm:write-latency',
              'autoalarm:write-latency-anomaly',
              'autoalarm:yellow-cluster',
              'autoalarm:red-cluster',
              'autoalarm:index-writes-blocked',
            ],
          },
        },
        description: 'Routes OpenSearch tag events to AutoAlarm',
      }),
    });

    openSearchRules.push({
      openSearchStateRule: new Rule(this, 'OpenSearchStateRule', {
        eventPattern: {
          source: ['aws.es'],
          detailType: ['Elasticsearch Service Domain Change'],
          detail: {
            state: ['CreateDomain', 'DeleteDomain'],
          },
        },
        description: 'Routes OpenSearch events to AutoAlarm',
      }),
    });

    this.serviceRules.set('opensearch', openSearchRules);
  }

  private addRdsRules() {
    const rdsRules = this.serviceRules.get('rds') || [];

    rdsRules.push({
      rdsTagRule: new Rule(this, 'RDSTagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['rds'],
            'resource-type': ['db'],
            'changed-tag-keys': [
              'autoalarm:enabled',
              'autoalarm:cpu',
              'autoalarm:cpu-anomaly',
              'autoalarm:write-latency',
              'autoalarm:write-latency-anomaly',
              'autoalarm:read-latency',
              'autoalarm:read-latency-anomaly',
              'autoalarm:freeable-memory',
              'autoalarm:freeable-memory-anomaly',
              'autoalarm:db-connections',
              'autoalarm:db-connections-anomaly',
              'autoalarm:dbload-anomaly',
              'autoalarm:swap-usage',
              'autoalarm:deadlocks',
              'autoalarm:disk-queue-depth-anomaly',
              'autoalarm:disk-queue-depth',
              'autoalarm:read-throughput-anomaly',
              'autoalarm:write-throughput-anomaly',
            ],
          },
        },
        description: 'Routes RDS tag events to AutoAlarm',
      }),
    });

    rdsRules.push({
      rdsStateRule: new Rule(this, 'RDSStateRule', {
        eventPattern: {
          source: ['aws.rds'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['rds.amazonaws.com'],
            eventName: ['CreateDBInstance', 'DeleteDBInstance'],
          },
        },
        description: 'Routes RDS events to AutoAlarm',
      }),
    });

    this.serviceRules.set('rds', rdsRules);
  }

  private addRdsClusterRules() {
    const rdsClusterRules = this.serviceRules.get('rdscluster') || [];

    rdsClusterRules.push({
      rdsClusterTagRule: new Rule(this, 'RDSClusterTagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['rds'],
            'resource-type': ['cluster'],
            'changed-tag-keys': [
              'autoalarm:enabled',
              'autoalarm:db-connections-anomaly',
              'autoalarm:replica-lag',
              'autoalarm:replica-lag-anomaly',
              'autoalarm:failover-state',
            ],
          },
        },
        description: 'Routes RDS Cluster tag events to AutoAlarm',
      }),
    });

    rdsClusterRules.push({
      rdsClusterStateRule: new Rule(this, 'RDSClusterStateRule', {
        eventPattern: {
          source: ['aws.rds'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['rds.amazonaws.com'],
            eventName: ['CreateDBCluster', 'DeleteDBCluster'],
          },
        },
        description: 'Routes RDS Cluster events to AutoAlarm',
      }),
    });

    this.serviceRules.set('rdscluster', rdsClusterRules);
  }

  private addRoute53ResolverRules() {
    const route53ResolverRules = this.serviceRules.get('route53resolver') || [];

    route53ResolverRules.push({
      route53ResolverTagRule: new Rule(this, 'Route53ResolverTagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['route53resolver'],
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
      }),
    });

    route53ResolverRules.push({
      route53ResolverStateRule: new Rule(this, 'Route53ResolverStateRule', {
        eventPattern: {
          source: ['aws.route53resolver'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['route53resolver.amazonaws.com'],
            eventName: ['CreateResolverEndpoint', 'DeleteResolverEndpoint'],
          },
        },
        description: 'Routes Route53Resolver events to AutoAlarm',
      }),
    });

    this.serviceRules.set('route53resolver', route53ResolverRules);
  }

  private addSqsRules() {
    const sqsRules = this.serviceRules.get('sqs') || [];

    sqsRules.push({
      sqsStateRule: new Rule(this, 'SqsRule', {
        eventPattern: {
          source: ['aws.sqs'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['sqs.amazonaws.com'],
            eventName: ['CreateQueue', 'DeleteQueue', 'TagQueue', 'UntagQueue'],
          },
        },
        description: 'Routes SQS events to AutoAlarm',
      }),
    });

    this.serviceRules.set('sqs', sqsRules);
  }

  private addSNFRules() {
    const sfnRules = this.serviceRules.get('sfn') || [];

    sfnRules.push({
      sfnStateRule: new Rule(this, 'SFNRule', {
        eventPattern: {
          source: ['aws.states'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['states.amazonaws.com'],
            eventName: ['CreateStateMachine', 'DeleteStateMachine'],
          },
        },
        description: 'Routes Step Functions events to AutoAlarm',
      }),
    });

    sfnRules.push({
      sfnTagRule: new Rule(this, 'SFNTagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['states'],
            'resource-type': ['stateMachine'],
            'changed-tag-keys': [
              'autoalarm:enabled',
              'autoalarm:executions-failed',
              'autoalarm:executions-failed-anomaly',
              'autoalarm:executions-aborted',
              'autoalarm:executions-aborted-anomaly',
              'autoalarm:executions-timed-out',
              'autoalarm:executions-timed-out-anomaly',
            ],
          },
        },
        description: 'Routes Step Functions tag events to AutoAlarm',
      }),
    });
    this.serviceRules.set('sfn', sfnRules);
  }

  private addTargetGroupRules() {
    const targetGroupRules = this.serviceRules.get('targetgroup') || [];

    targetGroupRules.push({
      targetGroupTagRule: new Rule(this, 'TargetGroupTagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['elasticloadbalancing'],
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
              'autoalarm:healthy-host-count',
            ],
          },
        },
        description: 'Routes Target Group tag events to AutoAlarm',
      }),
    });

    targetGroupRules.push({
      targetGroupStateRule: new Rule(this, 'TargetGroupStateRule', {
        eventPattern: {
          source: ['aws.elasticloadbalancing'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['elasticloadbalancing.amazonaws.com'],
            eventName: ['CreateTargetGroup', 'DeleteTargetGroup'],
          },
        },
        description: 'Routes Target Group events to AutoAlarm',
      }),
    });

    this.serviceRules.set('targetgroup', targetGroupRules);
  }

  private addTransitGatewayRules() {
    const transitGatewayRules = this.serviceRules.get('transitgateway') || [];

    transitGatewayRules.push({
      transitGatewayTagRule: new Rule(this, 'TransitGatewayTagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['ec2'],
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
      }),
    });

    transitGatewayRules.push({
      transitGatewayStateRule: new Rule(this, 'TransitGatewayStateRule', {
        eventPattern: {
          source: ['aws.ec2'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['ec2.amazonaws.com'],
            eventName: ['CreateTransitGateway', 'DeleteTransitGateway'],
          },
        },
        description: 'Routes Transit Gateway events to AutoAlarm',
      }),
    });

    this.serviceRules.set('transitgateway', transitGatewayRules);
  }

  private addVpnRules() {
    const vpnRules = this.serviceRules.get('vpn') || [];

    vpnRules.push({
      vpnTagRule: new Rule(this, 'VPNTagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['ec2'],
            'resource-type': ['vpn-connection'],
            'changed-tag-keys': [
              'autoalarm:enabled',
              'autoalarm:tunnel-state',
              'autoalarm:tunnel-state-anomaly',
            ],
          },
        },
        description: 'Routes VPN tag events to AutoAlarm',
      }),
    });

    vpnRules.push({
      vpnStateRule: new Rule(this, 'VPNStateRule', {
        eventPattern: {
          source: ['aws.ec2'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['ec2.amazonaws.com'],
            eventName: ['CreateVpnConnection', 'DeleteVpnConnection'],
          },
        },
        description: 'Routes VPN events to AutoAlarm',
      }),
    });

    this.serviceRules.set('vpn', vpnRules);
  }

  /**
   * Private method to set targets for each rule
   * @param eventBridgeRules - The rule to add targets to
   * @param queues - an object containing the queues to add as targets
   */
  private eventRuleTargetSetter(
    eventBridgeRules: EventRules,
    queues: {[key: string]: NoBreachingExtendedQueue},
  ): void {
    try {
      for (const serviceName of eventBridgeRules.serviceRules.keys()) {
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
        const serviceRules = eventBridgeRules.serviceRules.get(serviceName);

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
