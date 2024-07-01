export enum ValidInstanceState {
  Running = 'running',
  Pending = 'pending', //this doesn't work because a pending instance cant report stats... duh. Let's remove it... later
  Stopped = 'stopped', //will be removed. For testing only.
  Stopping = 'stopping', //will be removed. For testing only.
  ShuttingDown = 'shutting-down', //will be removed. For testing only.
  Terminated = 'terminated',
}
export enum AlarmClassification {
  Critical = 'CRITICAL',
  Warning = 'WARNING',
}

export enum ValidAlbState {
  Active = 'active',
  Provisioning = 'provisioning',
  Failed = 'failed',
  Deleted = 'deleted',
}

export enum ValidTargetGroupState {
  Active = 'active',
  Initial = 'initial',
  Draining = 'draining',
  Deleted = 'deleted',
}

export enum ValidSqsState {
  Active = 'active',
  Deleted = 'deleted',
}

export enum ValidOpenSearchState {
  Active = 'active',
  Processing = 'processing',
  Deleted = 'deleted',
}
