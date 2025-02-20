import {Construct} from 'constructs';
import {Rule} from 'aws-cdk-lib/aws-events';

type ServiceName =
  | 'alb'
  | 'cloudfront'
  | 'ec2'
  | 'opensearch'
  | 'rds'
  | 'rdscluster'
  | 'route53resolver'
  | 'sqs'
  | 'targetgroup'
  | 'transitgateway'
  | 'vpn';

type RuleObject = {
  [ruleName: string]: Rule;
};

export class EventRules extends Construct {
  public readonly rules: Map<ServiceName, RuleObject[]>;
  private readonly accountId: string;
  private readonly region: string;

  constructor(scope: Construct, id: string, accountId: string, region: string) {
    super(scope, id);
    this.accountId = accountId;
    this.region = region;
    this.rules = new Map();
    this.initializeRules();
  }

  /**
   * Annoyingly, we can't loop through attributes of a type so we have to manualy be a bit repetitive here.
   * @private
   */
  private initializeRules() {
    const services: ServiceName[] = [
      'alb',
      'cloudfront',
      'ec2',
      'opensearch',
      'rds',
      'rdscluster',
      'route53resolver',
      'sqs',
      'targetgroup',
      'transitgateway',
      'vpn',
    ];

    /**
     * Initialize the rules map with empty arrays for each service
     */
    services.forEach((service) => {
      this.rules.set(service, []);
    });

    /**
     * Add rules for each service
     */
    this.addAlbRules();
    this.addCloudFrontRules();
    this.addEc2Rules();
    this.addOpenSearchRules();
    this.addRdsRules();
    this.addRdsClusterRules();
    this.addRoute53ResolverRules();
    this.addSqsRules();
    this.addTargetGroupRules();
    this.addTransitGatewayRules();
    this.addVpnRules();
  }

  private addAlbRules() {
    const albRules = this.rules.get('alb') || [];

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

    this.rules.set('alb', albRules);
  }

  private addCloudFrontRules() {
    const cloudFrontRules = this.rules.get('cloudfront') || [];

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

    this.rules.set('cloudfront', cloudFrontRules);
  }

  private addEc2Rules() {
    const ec2Rules = this.rules.get('ec2') || [];
    ec2Rules.push({
      ec2TagRule: new Rule(this, 'ec2TagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['ec2', 'ecs', 'rds'], //TODO: Why are we including ecs, rds here?
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

    this.rules.set('ec2', ec2Rules);
  }

  private addOpenSearchRules() {
    const openSearchRules = this.rules.get('opensearch') || [];

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

    this.rules.set('opensearch', openSearchRules);
  }

  private addRdsRules() {
    const rdsRules = this.rules.get('rds') || [];

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

    this.rules.set('rds', rdsRules);
  }

  private addRdsClusterRules() {
    const rdsClusterRules = this.rules.get('rdscluster') || [];

    rdsClusterRules.push({
      rdsClusterTagRule: new Rule(this, 'RDSClusterTagRule', {
        eventPattern: {
          source: ['aws.tag'],
          detailType: ['Tag Change on Resource'],
          detail: {
            'service': ['rds'],
            'resource-arn': [
              {prefix: `arn:aws:rds:${this.region}:${this.accountId}:cluster/`},
            ], // Ensures only clusters are matched
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

    this.rules.set('rdscluster', rdsClusterRules);
  }

  private addRoute53ResolverRules() {
    const route53ResolverRules = this.rules.get('route53resolver') || [];

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

    this.rules.set('route53resolver', route53ResolverRules);
  }

  private addSqsRules() {
    const sqsRules = this.rules.get('sqs') || [];

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

    this.rules.set('sqs', sqsRules);
  }

  private addTargetGroupRules() {
    const targetGroupRules = this.rules.get('targetgroup') || [];

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

    this.rules.set('targetgroup', targetGroupRules);
  }

  private addTransitGatewayRules() {
    const transitGatewayRules = this.rules.get('transitgateway') || [];

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

    this.rules.set('transitgateway', transitGatewayRules);
  }

  private addVpnRules() {
    const vpnRules = this.rules.get('vpn') || [];

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

    this.rules.set('vpn', vpnRules);
  }

  // Helper methods for accessing rules
  public getRulesByService(service: ServiceName): RuleObject[] {
    return this.rules.get(service) || [];
  }

  public getRule(service: ServiceName, ruleName: string): Rule | undefined {
    const serviceRules = this.rules.get(service);
    const ruleObject = serviceRules?.find(
      (obj) => Object.keys(obj)[0] === ruleName,
    );
    return ruleObject ? Object.values(ruleObject)[0] : undefined;
  }

  public getAllRules(): Rule[] {
    const allRules: Rule[] = [];
    this.rules.forEach((serviceRules) => {
      serviceRules.forEach((ruleObj) => {
        allRules.push(...Object.values(ruleObj));
      });
    });
    return allRules;
  }
}
