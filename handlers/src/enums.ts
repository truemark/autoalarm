export enum ValidInstanceState {
  Running = 'running',
  Pending = 'pending',
  Stopped = 'stopped',
  Stopping = 'stopping',
  ShuttingDown = 'shutting-down',
  Terminated = 'terminated',
}

export enum RDSInstanceState {
  Available = 'available',
  BackingUp = 'backing-up',
  Creating = 'creating',
  Deleting = 'deleting',
  Failed = 'failed',
  Modifying = 'modifying',
  Rebooting = 'rebooting',
}
export enum AlarmClassification {
  Critical = 'Critical',
  Warning = 'Warning',
}
export enum ServiceType {
  EC2 = 'EC2',
  RDS = 'RDS',
  ECS = 'ECS',
}

export interface ServiceConfig {
  namespaces: {namespace: string; dimensionName: string}[];
}

export const SERVICE_CONFIGS: Record<ServiceType, ServiceConfig> = {
  [ServiceType.EC2]: {
    namespaces: [
      {namespace: 'AWS/EC2', dimensionName: 'InstanceId'},
      {namespace: 'CWAgent', dimensionName: 'InstanceId'},
    ],
  },
  [ServiceType.RDS]: {
    namespaces: [{namespace: 'AWS/RDS', dimensionName: 'DBInstanceIdentifier'}],
  },
  [ServiceType.ECS]: {
    namespaces: [{namespace: 'AWS/ECS', dimensionName: 'ClusterName'}],
  },
};
