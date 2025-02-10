import {
  queryPrometheusForService,
  batchUpdatePromRules,
  batchPromRulesDeletion,
} from './prometheus-tools.mjs';
import * as logging from '@nr1e/logging';
import {DescribeDBInstancesCommand, RDSClient} from '@aws-sdk/client-rds';
import {DBAlarmManagerArray} from './types.mjs';

const log: logging.Logger = logging.newLogger('db-collector-modules');
const prometheusWorkspaceId: string = process.env.PROMETHEUS_WORKSPACE_ID || '';
const region: string = process.env.AWS_REGION || '';

const rdsClient = new RDSClient({region});

async function getDBInstanceDetails(dbInstanceId: string) {
  try {
    const command = new DescribeDBInstancesCommand({
      DBInstanceIdentifier: dbInstanceId,
    });
    const response = await rdsClient.send(command);

    return response.DBInstances?.[0];
  } catch (error) {
    log
      .error()
      .str('function', 'getDBInstanceDetails')
      .err(error)
      .str('dbInstanceId', dbInstanceId)
      .msg('Error fetching database instance details');
    return null;
  }
}

/**
 * Fetch tags for a given RDS database.
 */
export async function fetchDatabaseTags(
  dbInstanceId: string,
): Promise<{[key: string]: string}> {
  try {
    const command = new DescribeDBInstancesCommand({
      DBInstanceIdentifier: dbInstanceId,
    });
    const response = await rdsClient.send(command);

    const tags: {[key: string]: string} = {};
    response.DBInstances?.[0]?.TagList?.forEach((tag) => {
      if (tag.Key && tag.Value) {
        tags[tag.Key] = tag.Value;
      }
    });

    log
      .info()
      .str('function', 'fetchDatabaseTags')
      .str('dbInstanceId', dbInstanceId)
      .str('tags', JSON.stringify(tags))
      .msg('Fetched database tags');

    return tags;
  } catch (error) {
    log
      .error()
      .str('function', 'fetchDatabaseTags')
      .err(error)
      .str('dbInstanceId', dbInstanceId)
      .msg('Error fetching database tags');
    return {};
  }
}

/**
 * Manage alarms for active databases reporting to Prometheus.
 */
export async function manageActiveDatabaseAlarms(
  activeDBInstancesArray: DBAlarmManagerArray,
) {
  const prometheusArray: DBAlarmManagerArray = [];
  const deletePrometheusAlarmsArray: DBAlarmManagerArray = [];

  const dbInstancesReportingToPrometheus: string[] = prometheusWorkspaceId
    ? await queryPrometheusForService('rds', prometheusWorkspaceId, region)
    : [];

  for (const {dbInstanceId, tags, state} of activeDBInstancesArray) {
    log
      .info()
      .str('function', 'manageActiveDatabaseAlarms')
      .str('dbInstanceId', dbInstanceId)
      .msg('Processing database instance');

    const isAlarmEnabled = tags['autoalarm:enabled'] === 'true';

    if (!isAlarmEnabled) {
      log
        .info()
        .str('function', 'manageActiveDatabaseAlarms')
        .str('dbInstanceId', dbInstanceId)
        .msg('Alarm creation disabled by tag settings');
      deletePrometheusAlarmsArray.push({dbInstanceId, tags, state});
      continue;
    }

    // Check if the database reports to Prometheus
    if (
      prometheusWorkspaceId &&
      (tags['autoalarm:target'] === 'prometheus' ||
        (!tags['autoalarm:target'] &&
          dbInstancesReportingToPrometheus.includes(dbInstanceId)))
    ) {
      log
        .info()
        .str('function', 'manageActiveDatabaseAlarms')
        .str('dbInstanceId', dbInstanceId)
        .msg('Database reports to Prometheus. Managing Prometheus alarms');

      prometheusArray.push({dbInstanceId, tags, state});
    } else {
      log
        .warn()
        .str('function', 'manageActiveDatabaseAlarms')
        .str('dbInstanceId', dbInstanceId)
        .msg('Database does not report to Prometheus. No alarms created.');
    }
  }

  // Create/update Prometheus alarms
  if (prometheusArray.length > 0) {
    await batchUpdatePromRules(prometheusWorkspaceId, 'rds', prometheusArray);
  }

  // Delete Prometheus alarms for disabled instances
  if (deletePrometheusAlarmsArray.length > 0) {
    await batchPromRulesDeletion(
      prometheusWorkspaceId,
      deletePrometheusAlarmsArray,
      'rds',
    );
  }
}

/**
 * Manage alarms for inactive databases (delete alarms if needed).
 */
export async function manageInactiveDatabaseAlarms(
  inactiveDBInstancesArray: DBAlarmManagerArray,
) {
  const dbInstancesReportingToPrometheus: string[] = prometheusWorkspaceId
    ? await queryPrometheusForService('rds', prometheusWorkspaceId, region)
    : [];

  const prometheusAlarmsToDelete: DBAlarmManagerArray = inactiveDBInstancesArray
    .filter((instance) =>
      dbInstancesReportingToPrometheus.includes(instance.dbInstanceId),
    )
    .map((instance) => ({
      dbInstanceId: instance.dbInstanceId,
      tags: instance.tags,
      state: instance.state,
    }));

  // Delete Prometheus alarms for inactive databases
  if (prometheusAlarmsToDelete.length > 0) {
    await batchPromRulesDeletion(
      prometheusWorkspaceId,
      prometheusAlarmsToDelete,
      'rds',
    );
  }
}
