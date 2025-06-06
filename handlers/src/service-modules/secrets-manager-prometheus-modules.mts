import {SecretsManagerClient} from '@aws-sdk/client-secrets-manager';
import {
  PROMETHEUS_MYSQL_CONFIGS,
  PROMETHEUS_ORACLEDB_CONFIGS,
  PROMETHEUS_POSTGRES_CONFIGS,
} from '../alarm-configs/index.mjs';
import {
  EventParseResult,
  MetricAlarmConfig,
  MetricAlarmOptions,
  ServiceEventMap,
  ValidEventName,
} from '../types/index.mjs';
import * as logging from '@nr1e/logging';
import {parseMetricAlarmOptions} from '../alarm-configs/utils/index.mjs';

export class SecManagerPrometheusModule {
  private static oracleDBConfigs = PROMETHEUS_ORACLEDB_CONFIGS;
  private static mysqlConfigs = PROMETHEUS_MYSQL_CONFIGS;
  private static postgresConfigs = PROMETHEUS_POSTGRES_CONFIGS;
  private static log = logging.getLogger('SecManagerPrometheusModule');

  public static readonly SecretsManagerEventMap: ServiceEventMap = {
    'aws.secretsmanager': {
      arnPattern: ['"arn:aws:secretsmanager:', '"'],
      resrcIdPattern: null,
      eventName: {
        UntagResource: {
          hasTags: true,
          tagsKey: 'tagKeys',
          idKeyName: 'secretId',
          isARN: true,
          isDestroyed: false,
          isCreated: false,
        },
        TagResource: {
          hasTags: true,
          tagsKey: 'tags',
          idKeyName: 'secretId',
          isARN: true,
          isDestroyed: false,
          isCreated: false,
        },
        DeleteSecret: {
          hasTags: false,
          tagsKey: null,
          idKeyName: 'arn',
          isARN: true,
          isDestroyed: true,
          isCreated: false,
        },
        CreateSecret: {
          hasTags: false,
          tagsKey: null,
          idKeyName: 'responseElements.arn',
          isARN: true,
          isDestroyed: false,
          isCreated: true,
        },
      },
    },
  } as const;

  // Private Constructor to prevent instantiation
  private constructor() {}

  //connect to secrets manager and pull the secret to a parse
  private static SecretsParse(
    arn: string,
    client: SecretsManagerClient,
  ): {
    engine: string | undefined;
    host: string | undefined;
  } {
    try {
      const secret = client.getSecretValue({SecretId: arn});
      if (!secret || !secret.SecretString) {
        this.log.error().str('ARN', arn).msg('Secret not found or empty');
        return {engine: undefined, host: undefined};
      }

      const secretData = JSON.parse(secret.SecretString);
      return {
        engine: secretData.engine,
        host: secretData.host,
      };
    } catch (error) {
      this.log
        .error()
        .str('ARN', arn)
        .unknown('error', error)
        .msg('Error retrieving secret from Secrets Manager');
      return {engine: undefined, host: undefined};
    }
  }

  // Helper function to fetch alarms
  private static fetchPrometheusAlarmsConfig: MetricAlarmConfig[] = (
    engine: string,
  ) => {
    //fetch prometheus alarm configs for oracle, mysql, or postgres using engine type
    return engine === 'mysql'
      ? this.mysqlConfigs
      : engine === 'oracle'
        ? this.oracleDBConfigs
        : engine === 'postgres'
          ? this.postgresConfigs
          : undefined;
  };

  private static async buildPromQuery(
    config: MetricAlarmConfig,
    host: string,
    tagValue?: string,
  ): Promise<string[]> {
    // Get alarm values for prometheus
    const {
      warningThreshold,
      criticalThreshold,
      prometheusExpression,
      statistic,
      period,
    } = tagValue
      ? parseMetricAlarmOptions(tagValue, config.defaults)
      : config.defaults;

    // build the prometheus query
    const xprBuild = (threshold: number | null) => {
      prometheusExpression!
        .replace('/_STATISTIC/', `${statistic}`)
        .replace('/_THRESHOLD/', `${threshold}`)
        .replace('/_PERIOD/', `${period}`)
        .replace('/_HOST/', host);
    };

    //return any non-null entries
    return [
      xprBuild(warningThreshold) ?? null,
      xprBuild(criticalThreshold) ?? null,
    ].filter((q) => q !== null);
  }

  // Helper function to manage alarm rules and build a prometheus rules config
  private static alarmRuleUpdater(
    created: string[],
    deleted: string[],
    updated: string[],
    currentRules: Record<string, any>,
  ): void {
    const promehteusAlarmsConfig = {};

    if (
      isCreated ||
      tags?.some(
        (tag) => tag.tagKey === 'autoalarm:enabled' && tag.tagValue === 'true',
      )
    ) {
      // create alarms for this secret
      alarmsToCreate.push('new-alarms-for-secret');
    }

    if (
      tags?.some(
        (tag) => tag.tagKey === 'autoalarm:enabled' && tag.tagValue === 'false',
      )
    ) {
      // update alarms for this secret
      alarmsToUpdate.push('update-alarms-for-secret');
    }

    return promehteusAlarmsConfig;
  }

  /**  TODO: We need to check if this is a create event becuase create events don't contain tag values
   *     even if a secretsmanager secret was created with a tag.
   *
   *   TODO: If we untag a resource, we need to wait because SecretsManager sends two events and they may come
   *    out of order. need to pull tags again... a 30 second wait should be enough.
   */
  public static async manageDbAlarms(
    eventParseResult: EventParseResult,
  ): Promise<boolean> {
    // arrays of alarms to to be deleted and to be updated
    // arrays of alarms to be deleted and to be updated
    const toCreate: string[] = [];
    const toDelete: string[] = [];
    const toUpdate: string[] = [];

    // Initialize the Secrets Manager client
    const client = new SecretsManagerClient({}); // TODO: add retry logic and region if needed.

    // untagging resources and created secrets that have tags send multiple events. Wait 30 sec and check for tags again.
    if (
      eventParseResult.isDestroyed ||
      eventParseResult.tags?.includes({tagKey: 'autoalarm:enabled'}) === false
    ) {
      // delete all alarms for this secret
    }

    if (
      eventParseResult.isCreated ||
      eventParseResult.eventName === 'UntagResource'
    ) {
      try {
        // Map RDS instance/cluster ARN to the SSM parameter ARN
        const rdsMapping = this.secretsManagerDbRouting();

        // build prom Queries
        const queries = this.createPromQuerysWithLables();

        //update prometheus rules
        //delete and update functionality - should be in prometheus-tools for a quick call.
      } catch (error) {
        this.log
          .error()
          .str('Function', 'manageDbAlarms')
          .unknown('error', error)
          .msg('Error managing DB alarms');
        return false;
      }

      // Return true if successful.
      return true;
    }
  }
}
