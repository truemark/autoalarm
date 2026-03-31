import {Construct} from 'constructs';
import {Stack} from 'aws-cdk-lib';
import {CfnStackSet} from 'aws-cdk-lib/aws-cloudformation';
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  Effect,
} from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
import * as path from 'path';

export interface SourceAccountStackSetSubConstructProps {
  /**
   * ARN of the AutoAlarm-Central EventBridge bus in the hub account.
   * Forwarded alarm events from source accounts are sent here.
   */
  readonly hubEventBusArn: string;

  /**
   * ARN of the OAM Sink in the hub account.
   * Leave empty to skip OAM Link creation in source accounts.
   */
  readonly sinkArn?: string;

  /**
   * Organizational Unit IDs to deploy the source account stack to.
   * Format: 'ou-xxxx-xxxxxxxx' (found in AWS Organizations console).
   * Required when permissionModel is SERVICE_MANAGED (default).
   */
  readonly targetOrganizationalUnitIds?: string[];

  /**
   * Target AWS account IDs to deploy the source account stack to.
   * Required when permissionModel is SELF_MANAGED.
   */
  readonly targetAccountIds?: string[];

  /**
   * Regions to deploy the source account stack to.
   * Must be concrete region strings (e.g. ['us-east-1', 'eu-west-1']).
   * Defaults to the hub stack's region.
   */
  readonly deploymentRegions?: string[];

  /**
   * OAM resource types to share from source accounts.
   * Defaults to CloudWatch Metrics and Log Groups.
   */
  readonly oamResourceTypes?: string[];

  /**
   * Optional log group name filter for the OAM Link (e.g. '/ecs/*,/aws/lambda/*').
   * Leave empty to share all log groups (subject to sink policy).
   */
  readonly logGroupFilter?: string;

  /**
   * Permission model for the StackSet.
   * SERVICE_MANAGED: requires hub account to be org management account or
   *   delegated CloudFormation StackSets administrator. Supports auto-deployment
   *   to new accounts joining the target OUs.
   * SELF_MANAGED: requires AWSCloudFormationStackSetAdministrationRole in hub
   *   and AWSCloudFormationStackSetExecutionRole in each target account.
   * Default: SERVICE_MANAGED
   */
  readonly permissionModel?: 'SERVICE_MANAGED' | 'SELF_MANAGED';

  /**
   * Automatically deploy to accounts added to target OUs in the future.
   * Only applies when permissionModel is SERVICE_MANAGED. Default: true.
   */
  readonly autoDeployToNewAccounts?: boolean;

  /**
   * Name of the execution role in target accounts for SELF_MANAGED StackSets.
   * This role must already exist in each target account.
   * Default: AWSCloudFormationStackSetExecutionRole
   */
  readonly executionRoleName?: string;
}

/**
 * Deploys the AutoAlarm source account setup (OAM Link + EventBridge forwarding rule)
 * to target accounts via CloudFormation StackSets.
 *
 * SERVICE_MANAGED (default): The hub account must be the AWS Organizations management
 * account or registered as a delegated administrator for CloudFormation StackSets.
 *
 * SELF_MANAGED: Creates an administration role in the hub account and requires
 * an execution role (AWSCloudFormationStackSetExecutionRole) in each target account.
 */
export class SourceAccountStackSetSubConstruct extends Construct {
  public readonly stackSet: CfnStackSet;

  constructor(
    scope: Construct,
    id: string,
    props: SourceAccountStackSetSubConstructProps,
  ) {
    super(scope, id);

    const region = Stack.of(this).region;
    const permissionModel = props.permissionModel ?? 'SERVICE_MANAGED';
    const deploymentRegions = props.deploymentRegions ?? [region];
    const oamResourceTypes = props.oamResourceTypes ?? [
      'AWS::CloudWatch::Metric',
      'AWS::Logs::LogGroup',
    ];

    // Read the CloudFormation template from the repo
    const templateBody = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        'cloudformation',
        'source-account-autoalarm.yaml',
      ),
      'utf-8',
    );

    const parameters: CfnStackSet.ParameterProperty[] = [
      {
        parameterKey: 'HubEventBusArn',
        parameterValue: props.hubEventBusArn,
      },
      {
        parameterKey: 'SinkArn',
        parameterValue: props.sinkArn ?? '',
      },
      {
        parameterKey: 'OamResourceTypes',
        parameterValue: oamResourceTypes.join(','),
      },
    ];

    if (props.logGroupFilter) {
      parameters.push({
        parameterKey: 'LogGroupFilter',
        parameterValue: props.logGroupFilter,
      });
    }

    if (permissionModel === 'SELF_MANAGED') {
      // Create the administration role in the hub account
      const adminRole = new Role(this, 'StackSetAdminRole', {
        roleName: 'AWSCloudFormationStackSetAdministrationRole',
        assumedBy: new ServicePrincipal('cloudformation.amazonaws.com'),
      });
      adminRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['sts:AssumeRole'],
          resources: [
            `arn:aws:iam::*:role/${props.executionRoleName ?? 'AWSCloudFormationStackSetExecutionRole'}`,
          ],
        }),
      );

      const targetAccountIds = props.targetAccountIds ?? [];

      this.stackSet = new CfnStackSet(this, 'SourceAccountStackSet', {
        stackSetName: 'AutoAlarm-SourceAccount',
        description:
          'Deploys OAM Link and EventBridge alarm forwarding rule in each source account.',
        permissionModel,
        capabilities: ['CAPABILITY_NAMED_IAM'],
        templateBody,
        parameters,
        administrationRoleArn: adminRole.roleArn,
        executionRoleName:
          props.executionRoleName ??
          'AWSCloudFormationStackSetExecutionRole',
        stackInstancesGroup: [
          {
            deploymentTargets: {
              accounts: targetAccountIds,
            },
            regions: deploymentRegions,
          },
        ],
      });
      this.stackSet.node.addDependency(adminRole);
    } else {
      this.stackSet = new CfnStackSet(this, 'SourceAccountStackSet', {
        stackSetName: 'AutoAlarm-SourceAccount',
        description:
          'Deploys OAM Link and EventBridge alarm forwarding rule in each source account.',
        permissionModel,
        capabilities: ['CAPABILITY_NAMED_IAM'],
        templateBody,
        parameters,
        autoDeployment: {
          enabled: props.autoDeployToNewAccounts ?? true,
          retainStacksOnAccountRemoval: false,
        },
        managedExecution: {Active: true},
        stackInstancesGroup: [
          {
            deploymentTargets: {
              organizationalUnitIds: props.targetOrganizationalUnitIds,
            },
            regions: deploymentRegions,
          },
        ],
      });
    }
  }
}
