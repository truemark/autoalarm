import {Construct} from 'constructs';
import {CfnSink} from 'aws-cdk-lib/aws-oam';
import {Stack} from 'aws-cdk-lib';

export interface OamSinkSubConstructProps {
  /**
   * Explicit list of source account IDs allowed to create links to this sink.
   * Mutually exclusive with organizationIds for the principal — but both can be
   * provided and they are merged into the sink policy.
   */
  readonly sourceAccountIds?: string[];

  /**
   * Organization IDs whose member accounts are allowed to create links.
   */
  readonly organizationIds?: string[];

  /**
   * OAM resource types to share. Defaults to metrics and log groups.
   */
  readonly resourceTypes?: string[];
}

export class OamSinkSubConstruct extends Construct {
  public readonly sink: CfnSink;
  public readonly sinkArn: string;

  constructor(
    scope: Construct,
    id: string,
    props: OamSinkSubConstructProps,
  ) {
    super(scope, id);

    const resourceTypes = props.resourceTypes ?? [
      'AWS::CloudWatch::Metric',
      'AWS::Logs::LogGroup',
    ];

    const sinkPolicy = this.buildSinkPolicy(
      props.sourceAccountIds,
      props.organizationIds,
      resourceTypes,
    );

    this.sink = new CfnSink(this, 'OamSink', {
      name: `AutoAlarm-OAM-Sink-${Stack.of(this).region}`,
      policy: sinkPolicy,
    });

    this.sinkArn = this.sink.attrArn;
  }

  private buildSinkPolicy(
    sourceAccountIds?: string[],
    organizationIds?: string[],
    resourceTypes?: string[],
  ): object {
    const statements: object[] = [];

    // Account-based access
    if (sourceAccountIds && sourceAccountIds.length > 0) {
      statements.push({
        Effect: 'Allow',
        Principal: {
          AWS: sourceAccountIds.map(
            (id) => `arn:aws:iam::${id}:root`,
          ),
        },
        Action: ['oam:CreateLink', 'oam:UpdateLink'],
        Resource: '*',
        Condition: {
          'ForAllValues:StringEquals': {
            'oam:ResourceTypes': resourceTypes,
          },
        },
      });
    }

    // Organization-based access
    if (organizationIds && organizationIds.length > 0) {
      statements.push({
        Effect: 'Allow',
        Principal: '*',
        Action: ['oam:CreateLink', 'oam:UpdateLink'],
        Resource: '*',
        Condition: {
          'ForAnyValue:StringEquals': {
            'aws:PrincipalOrgID': organizationIds,
          },
          'ForAllValues:StringEquals': {
            'oam:ResourceTypes': resourceTypes,
          },
        },
      });
    }

    return {
      Version: '2012-10-17',
      Statement: statements,
    };
  }
}
