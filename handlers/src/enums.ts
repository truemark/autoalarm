export enum ValidInstanceState {
  Running = 'running',
  Pending = 'pending',
  Stopped = 'stopped', //will be removed. For testing only.
  Stopping = 'stopping', //will be removed. For testing only.
  ShuttingDown = 'shutting-down', //will be removed. For testing only.
  Terminated = 'terminated',
}
export enum AlarmClassification {
  Critical = 'Critical',
  Warning = 'Warning',
}
