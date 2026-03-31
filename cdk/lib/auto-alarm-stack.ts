import {Construct} from 'constructs';
import {AutoAlarmConstruct} from './auto-alarm-construct';
import {ExtendedStack, ExtendedStackProps} from 'truemark-cdk-lib/aws-cdk';
import {CronOptions} from 'aws-cdk-lib/aws-events';
import {version} from '../../package.json';

export interface ExtendedAutoAlarmProps extends ExtendedStackProps {
  readonly prometheusWorkspaceId?: string;
  readonly enableReAlarm?: boolean;
  readonly reAlarmSchedule?: CronOptions;
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

export class AutoAlarmStack extends ExtendedStack {
  constructor(scope: Construct, id: string, props: ExtendedAutoAlarmProps) {
    // Use the extended interface here
    super(scope, id, props);
    new AutoAlarmConstruct(this, 'AutoAlarmConstruct', {
      prometheusWorkspaceId: props.prometheusWorkspaceId,
      enableReAlarm: props.enableReAlarm,
      enableOamSink: props.enableOamSink,
      oamSourceAccountIds: props.oamSourceAccountIds,
      oamOrganizationIds: props.oamOrganizationIds,
      oamResourceTypes: props.oamResourceTypes,
      enableEnrichment: props.enableEnrichment,
      enrichmentSourceAccountIds: props.enrichmentSourceAccountIds,
      enrichmentOrganizationIds: props.enrichmentOrganizationIds,
      enableAgentEnrichment: props.enableAgentEnrichment,
      agentRuntimeArn: props.agentRuntimeArn,
      agentSeverityFilter: props.agentSeverityFilter,
      enableSourceAccountStackSet: props.enableSourceAccountStackSet,
      stackSetTargetOuIds: props.stackSetTargetOuIds,
      stackSetTargetAccountIds: props.stackSetTargetAccountIds,
      stackSetDeploymentRegions: props.stackSetDeploymentRegions,
      stackSetLogGroupFilter: props.stackSetLogGroupFilter,
      stackSetPermissionModel: props.stackSetPermissionModel,
    });
    this.outputParameter('Name', 'AutoAlarm');
    this.outputParameter('Version', version);
    if (props.prometheusWorkspaceId) {
      this.outputParameter(
        'prometheusWorkspaceId',
        props.prometheusWorkspaceId,
      );
    }
    if (props.enableReAlarm) {
      this.outputParameter(
        'useReAlarm',
        props.enableReAlarm ? 'true' : 'false',
      );
    }
    if (props.reAlarmSchedule) {
      this.outputParameter(
        'reAlarmSchedule',
        JSON.stringify(props.reAlarmSchedule),
      );
    }
    if (props.enableOamSink) {
      this.outputParameter('enableOamSink', 'true');
    }
    if (props.enableEnrichment) {
      this.outputParameter('enableEnrichment', 'true');
    }
  }
}
