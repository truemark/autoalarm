import {ExtendedStackProps} from 'truemark-cdk-lib/aws-cdk';

/*
 * ExtendedAutoAlarmProps extends ExtendedStackProps so we can use an extended interface for the AutoAlarmStack to pass
 * in the prometheusWorkspaceId. We use the extended stack props from the truemark-cdk-lib/aws-cdk package to maintain
 * consistency with the required cdk props while still being able to ingest necessary types for env variables. This
 * allows flexibility in the future to implement additional alarm paradigms without further changing the stack props or
 * extending these classes.
 */

export interface ExtendedAutoAlarmProps extends ExtendedStackProps {
  prometheusWorkspaceId?: string;
}
