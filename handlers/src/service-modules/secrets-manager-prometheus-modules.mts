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
import {deletePromRulesForService, parseMetricAlarmOptions} from '../alarm-configs/utils/index.mjs';

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

  // Helper Function to fetch tags from Secrets Manager if eventParseResult does not have them
  private static async fetchSecretTags(
    arn: string,
    client: SecretsManagerClient,
  ): Promise<Record<string, string> | undefined> {
    try {
      const tags = await client.listSecretTags({SecretId: arn}); // TODO

      // We don't care if there are not any tags. Early return if none.
      if (!tags || !tags.Tags || tags.Tags.length === 0) {
        this.log.warn().str('ARN', arn).msg('No tags found for secret');
        return undefined;
      }

      // Filter out any non-autoalarm tags
      const autoAlarmTags = tags.Tags.filter((tag: {Key: string}) =>
        tag.Key.startsWith('autoalarm:'),
      );

    // If no autoalarm tags, we're not interested... return undefined
    if (autoAlarmTags.length === 0) {
            this.log
                .warn()
                .str('Function', 'fetchSecretTags')
                .str('ARN', arn)
                .obj('DiscoveredTags', tags.Tags)
                .msg('No autoalarm tags found for secret');
            return undefined; // return undefined if no autoalarm tags are present
        }


      // return all autoalarm tags
      return tags.tags

    } catch (error) {
      this.log
          .fatal()
          .str('Function', 'fetchSecretTags')
          .str('ARN', arn)
          .unknown('error', error)
          .msg('Error fetching tags from Secrets Manager. Manually review tags, logs and debug this function');
      return undefined;
    }
  }

  // Helper function to fetch alarms
  private static fetchPrometheusAlarmsConfig = (
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
  private static async alarmRuleUpdater(
    tags: Record<string, string>,
    engine: string, // engine type from secret (mysql, oracle, postgres)
    host: string, // host from secret (eventParseResult.host)
    isUntagged?: boolean, // Not needed if autoalarm is disabled
    isDisabled?: boolean, // Not needed if autoalarm is not disabled
  ): Promise<{ iSuccess: boolean; res: Error| string }> {
    const prometheusWorkspaceId: string =
      process.env.PROMETHEUS_WORKSPACE_ID || '';

  if (!prometheusWorkspaceId) {
      return {iSuccess: false, res: new Error('Missing PROMETHEUS_WORKSPACE_ID')};
    }

    // If isDisabled is true, delete all Prometheus Alarm Rules and return
    if (isDisabled) {
      try {
        await deletePromRulesForService(
          prometheusWorkspaceId,
          engine,
          [host],
        );
        return Promise.resolve(
          {iSuccess: true, res: 'Deleted all Prometheus alarm rules for disabled autoalarm secret.'},
        );
      } catch (err) {
        return { iSuccess: false, res: new Error('Failed to delete Prometheus Alarms ', {cause: err}) };
      }
    }

    // Get default configs for the correct DB engine (eventParseResult.engine)
    const configs = this.fetchPrometheusAlarmsConfig(engine);

    // Big problem. If no configs are found, return early with error obj.
    if (!configs) {
      return { iSuccess: false, res: new Error('No Prometheus alarm configs found for the specified engine. ' +
          'The following was returned when calling fetchPrometheusAlarmsConfig: ', configs) };
    }

    /**
     * UntagResource events only contain keys so we just grab the default values
     */
    if (isUntagged) {
      try {
        const configs = this.fetchPrometheusAlarmsConfig(engine);
        // TODO: Add logic to update alarm configs for untagged secrets
        return { iSuccess: true, res: 'Alarms successfully updated for untagged values.'}
      } catch (err) {
        return { iSuccess: false, res: new Error('Failed to updated alarms associated with changed tag values.', {cause: err}) };
      }
    }

    // If none of the conditions above are met, we must be in a TagResource event.
    return { iSuccess: false, res: new Error('TagResource event detected, but alarm rule updater is not implemented yet. Please check logs and debug.') };


  }

  public static async manageDbAlarms(
    eventParseResult: EventParseResult,
  ): Promise<boolean> {
    // arrays of alarms to be deleted and to be updated

    /**
     * Both destroyed and created events do not contain changed tags. However, both scenarios provide follow-up
     * tag or untag events that will contain the tags needed to manage alarms. Early return here with logging.
     */
    if (eventParseResult.isCreated || eventParseResult.isDestroyed) {
      this.log
        .info()
        .str('Function', 'manageDbAlarms')
        .str('ARN', eventParseResult.id)
        .str('EventName', eventParseResult.eventName)
        .bool('isCreated', eventParseResult.isCreated)
        .bool('isDestroyed', eventParseResult.isDestroyed)
        .msg(
          'Create or Delete event detected, skipping alarm management for now until follow up event with tags is received.',
        );

      return false;
    }

    // Initialize the Secrets Manager client
    const client = new SecretsManagerClient({}); // TODO: add retry logic and region if needed.

    // Get Host and Engine from secret
    const resourceInfo = this.SecretsParse(eventParseResult.id, client);

    // If either host or engine are undefined, we cannot manage alarms. Log and return false.
    if (!resourceInfo.engine || !resourceInfo.host) {
  this.log
        .error()
        .str('Function', 'manageDbAlarms')
        .str('ARN', eventParseResult.id)
        .obj('Host and Engine', resourceInfo)
        .msg('Secret does not contain valid engine or host information. Exiting alarm management.');
      return false; // exit if engine or host are not found
    }


    /**
     * Instantiate tags const with fall back logic in case eventParseResult.tags is empty, but we have a valid ARN
     * Untag and Tag events should ALWAYS have tags but provide a fallback to fetch tags if needed.
     */
    const secretTags = eventParseResult.tags
      ? eventParseResult.tags
      : await this.fetchSecretTags(eventParseResult.id, client);

    // return if no tags are found - looking only for autoalarm tags
    if (!secretTags) {
      this.log
        .error()
        .str('Function', 'manageDbAlarms')
        .str('ARN', eventParseResult.id)
        .msg(
          'No tags found for secret in eventParseResult or via manual tag fetching, skipping alarm management. ' +
            'Check logs and debug for issues in event parsing.',
        );
      return false;
    }

    // If autoalarm:enabled === false, imeadiately move to delete all Prometheus alarms associated with host and engine.
    if (secretTags['autoalarm:enabled'] === 'false') {
      this.log
        .info()
        .str('Function', 'manageDbAlarms')
        .str('ARN', eventParseResult.id)
        .msg('Alarm management is disabled for this secret. Exiting.');
      try {
        await this.alarmRuleUpdater(
          secretTags,
          resourceInfo.engine,
          resourceInfo.host,
          false)
      }
      return false; // exit if autoalarm is disabled
    }
  }
}
