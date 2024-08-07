export enum ValidInstanceState {
  Running = 'running',
  //Pending = 'pending', //this doesn't work because a pending instance cant report stats... duh. Let's remove it... later
  Stopped = 'stopped', //will be removed. For testing only.
  //Stopping = 'stopping', //will be removed. For testing only.
  //ShuttingDown = 'shutting-down', //will be removed. For testing only.
  Terminated = 'terminated',
}
export enum AlarmClassification {
  Critical = 'Critical',
  Warning = 'Warning',
}

export enum ValidAlbEvent {
  Active = 'CreateLoadBalancer',
  Deleted = 'DeleteLoadBalancer',
}

export enum ValidTargetGroupEvent {
  Active = 'CreateTargetGroup',
  Deleted = 'DeleteTargetGroup',
}

export enum ValidSqsEvent {
  CreateQueue = 'CreateQueue',
  DeleteQueue = 'DeleteQueue',
}

export enum ValidOpenSearchState {
  Active = 'active',
  Processing = 'processing',
  Deleted = 'deleted',
}
