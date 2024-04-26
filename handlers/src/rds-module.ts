import {
  DescribeDBInstancesCommand,
  DBInstance,
  RDSClient,
} from '@aws-sdk/client-rds';
import {
  CloudWatchClient,
  PutMetricAlarmCommand,
} from '@aws-sdk/client-cloudwatch';
import * as logging from '@nr1e/logging';
import {AlarmClassification, ValidDBInstanceState} from './enums';
import {AlarmProps, Tag} from './types';
import {doesAlarmExist, createOrUpdateAlarm, deleteAlarm} from './alarm-tools';

const log = logging.getRootLogger();
const rdsClient = new RDSClient({});
const cloudWatchClient = new CloudWatchClient({});

async function getDBInstanceEngine(
  dbInstanceId: string
): Promise<{engine: string | null}> {
  try {
    const describeDBInstancesCommand = new DescribeDBInstancesCommand({
      DBInstanceIdentifier: dbInstanceId,
    });
    const describeDBInstancesResponse = await rdsClient.send(
      describeDBInstancesCommand
    );

    const dbInstance = describeDBInstancesResponse
      .DBInstances?.[0] as DBInstance;
    if (!dbInstance.Engine) {
      log
        .info()
        .err('No engine details found')
        .str('dbInstanceId', dbInstanceId)
        .msg('No engine details found');
      throw new Error('No engine details found');
    }
    log
      .info()
      .str('dbInstanceId', dbInstanceId)
      .str('engine', dbInstance.Engine)
      .msg('Engine details found');
    return {engine: dbInstance.Engine};
  } catch (error) {
    log
      .error()
      .err(error)
      .str('dbInstanceId', dbInstanceId)
      .msg('Failed to fetch DB instance details');
    return {engine: null};
  }
}

export async function manageCPUUsageAlarmForDBInstance(
  dbInstanceId: string,
  tags: Tag,
  type: AlarmClassification
): Promise<void> {
  const alarmName = `AutoAlarm-RDS-${dbInstanceId}-${type}CPUUtilization`;
  const thresholdKey = `autoalarm:cpu-percent-above-${type.toLowerCase()}`;
  const durationTimeKey = 'autoalarm:cpu-percent-duration-time';
  const durationPeriodsKey = 'autoalarm:cpu-percent-duration-periods';
  const defaultThreshold = type === 'Critical' ? 90 : 80;

  const alarmProps: AlarmProps = {
    threshold: defaultThreshold,
    period: 60,
    namespace: 'AWS/RDS',
    evaluationPeriods: 5,
    metricName: 'CPUUtilization',
    dimensions: [{Name: 'DBInstanceIdentifier', Value: dbInstanceId}],
  };

  await createOrUpdateAlarm(
    alarmName,
    dbInstanceId,
    alarmProps,
    tags,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey
  );
}

export async function manageStorageAlarmForDBInstance(
  dbInstanceId: string,
  tags: Tag,
  type: AlarmClassification
): Promise<void> {
  const alarmName = `AutoAlarm-RDS-${dbInstanceId}-${type}StorageUtilization`;
  const thresholdKey = `autoalarm:storage-used-percent-${type.toLowerCase()}`;
  const durationTimeKey = 'autoalarm:storage-percent-duration-time';
  const durationPeriodsKey = 'autoalarm:storage-percent-duration-periods';
  const defaultThreshold = type === 'Critical' ? 85 : 75;

  const alarmProps: AlarmProps = {
    threshold: defaultThreshold,
    period: 60,
    namespace: 'AWS/RDS',
    evaluationPeriods: 5,
    metricName: 'FreeStorageSpace',
    dimensions: [{Name: 'DBInstanceIdentifier', Value: dbInstanceId}],
  };

  await createOrUpdateAlarm(
    alarmName,
    dbInstanceId,
    alarmProps,
    tags,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey
  );
}

export async function manageMemoryAlarmForDBInstance(
  dbInstanceId: string,
  tags: Tag,
  type: AlarmClassification
): Promise<void> {
  const alarmName = `AutoAlarm-RDS-${dbInstanceId}-${type}MemoryUtilization`;
  const defaultThreshold = type === 'Critical' ? 95 : 85;
  const thresholdKey = `autoalarm:memory-percent-above-${type.toLowerCase()}`;
  const durationTimeKey = 'autoalarm:memory-percent-duration-time';
  const durationPeriodsKey = 'autoalarm:memory-percent-duration-periods';

  const alarmProps: AlarmProps = {
    metricName: 'FreeableMemory',
    namespace: 'AWS/RDS',
    threshold: defaultThreshold,
    period: 60,
    evaluationPeriods: 5,
    dimensions: [{Name: 'DBInstanceIdentifier', Value: dbInstanceId}],
  };

  await createOrUpdateAlarm(
    alarmName,
    dbInstanceId,
    alarmProps,
    tags,
    thresholdKey,
    durationTimeKey,
    durationPeriodsKey
  );
}

export async function getRDSIdAndState(
  event: any
): Promise<{dbInstanceId: string; state: ValidDBInstanceState}> {
  const dbInstanceId = event.detail['DBInstanceIdentifier'];
  const state = event.detail['state'];
  return {dbInstanceId, state};
}

export const liveStates: Set<ValidDBInstanceState> = new Set([
  ValidDBInstanceState.Available,
  ValidDBInstanceState.BackingUp,
  ValidDBInstanceState.Creating,
  ValidDBInstanceState.Modifying,
  ValidDBInstanceState.Rebooting,
  ValidDBInstanceState.Renaming,
  ValidDBInstanceState.ResettingMasterCredentials,
  ValidDBInstanceState.Upgrading,
]);

export const deadStates: Set<ValidDBInstanceState> = new Set([
  ValidDBInstanceState.Deleting,
  ValidDBInstanceState.Failed,
  ValidDBInstanceState.RestoreError,
  ValidDBInstanceState.StorageFull,
  ValidDBInstanceState.Stopped,
  ValidDBInstanceState.configuringEnhancedMonitoring,
  ValidDBInstanceState.configuringIAMDatabaseAuthentication,
  ValidDBInstanceState.configuringLogExports,
  ValidDBInstanceState.convertingToVpc,
  ValidDBInstanceState.DeletePreCheck,
  ValidDBInstanceState.inaccessibleEncryptionCredentials,
  ValidDBInstanceState.inaccessibleEncryptionCredentialsRecoverable,
  ValidDBInstanceState.incompatibleNetwork,
  ValidDBInstanceState.incompatibleOptionGroup,
  ValidDBInstanceState.incompatibleParameters,
  ValidDBInstanceState.insufficientCapacity,
  ValidDBInstanceState.Maintenance,
  ValidDBInstanceState.MovingToVpc,
  ValidDBInstanceState.Starting,
  ValidDBInstanceState.storageConfigUpgrade,
  ValidDBInstanceState.StorageOptimization,
]);

export async function manageInactiveRDSAlarms(instanceId: string) {
  const alarmAnchors = [
    'CriticalCPUUtilization',
    'WarningCPUUtilization',
    'CriticalStorageUtilization',
    'WarningStorageUtilization',
  ];

  // Delete all alarms associated with the DB instance
  try {
    await Promise.all(
      alarmAnchors.map(alarm => deleteAlarm(instanceId, alarm))
    );
    log
      .info()
      .str('instanceId', instanceId)
      .msg('All alarms deleted for inactive RDS instance');
  } catch (e) {
    log
      .error()
      .err(e)
      .str('instanceId', instanceId)
      .msg('Error deleting alarms for RDS instance');
    throw new Error(`Error deleting alarms for RDS instance: ${e}`);
  }
}

export async function manageActiveRDSAlarms(dbInstanceId: string, tags: Tag) {
  // This function manages alarms for active RDS instances based on their current state and classification
  for (const classification of Object.values(AlarmClassification)) {
    try {
      await Promise.all([
        manageCPUUsageAlarmForDBInstance(dbInstanceId, tags, classification),
        manageStorageAlarmForDBInstance(dbInstanceId, tags, classification),
        manageMemoryAlarmForDBInstance(dbInstanceId, tags, classification),
      ]);
      log
        .info()
        .str('instanceId', dbInstanceId)
        .msg(
          `Alarms managed for active RDS instance with classification: ${classification}`
        );
    } catch (e) {
      log
        .error()
        .err(e)
        .str('instanceId', dbInstanceId)
        .msg(
          `Error managing alarms for active RDS instance with classification: ${classification}`
        );
      throw new Error(`Error managing alarms for active RDS instance: ${e}`);
    }
  }
}
