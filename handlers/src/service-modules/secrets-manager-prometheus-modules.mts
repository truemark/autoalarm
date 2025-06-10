import {
  SecretsManagerClient,
  DescribeSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  PROMETHEUS_MYSQL_CONFIGS,
  PROMETHEUS_ORACLEDB_CONFIGS,
  PROMETHEUS_POSTGRES_CONFIGS,
} from '../alarm-configs/index.mjs';
import {
  AlarmUpdateOptions,
  AlarmUpdateResult,
  EventParseResult,
  MetricAlarmConfig,
  ServiceEventMap,
  TagsObject,
} from '../types/index.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import * as logging from '@nr1e/logging';
import {
  deletePromRulesForService,
  parseMetricAlarmOptions,
} from '../alarm-configs/utils/index.mjs';

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
  private static secretsParse(
    arn: string,
    client: SecretsManagerClient,
  ): AlarmUpdateResult<{
    engine: string | undefined;
    host: string | undefined;
    secretsFound: boolean;
  }> {
    try {
      const secret = client.getSecretValue({SecretId: arn});

      if (!secret || !secret.SecretString) {
        return {
          isSuccess: true,
          res: new Error(`Secret not found or empty for ARN: ${arn}`),
          data: {
            engine: undefined,
            host: undefined,
            secretsFound: false,
          },
        };
      }

      // Parse the secret string to extract engine and host
      const secretData = JSON.parse(secret.SecretString);
      return {
        isSuccess: true,
        res: 'Successfully retrieved secret data',
        data: {
          engine: secretData.engine,
          host: secretData.host,
          secretsFound: true,
        },
      };
    } catch (err) {
      return {
        isSuccess: false,
        res: new Error(`Failed to retrieve secret for ARN: ${arn}:`, {
          cause: err,
        }),
      };
    }
  }

  // Helper Function to fetch tags from Secrets Manager if eventParseResult does not have them
  private static async fetchTags(
    eventParseResult: EventParseResult,
    client: SecretsManagerClient,
  ): Promise<AlarmUpdateResult<{tags: TagsObject | undefined}>> {
    let tags;

    // first check if the eventParsed result has tags and use them if it does
    const parsedTags: TagsObject | undefined = eventParseResult.hasTags
      ? eventParseResult.tags
      : undefined;

    // If tags are present in the eventParseResult, assign parsedTags to tags
    tags = parsedTags ? (parsedTags satisfies TagsObject) : undefined;

    // If no tags in eventParseResult, try to fetch them from Secrets Manager

    try {
      tags = (
        await client.send(
          new DescribeSecretCommand({SecretId: eventParseResult.id}),
        )
      ).Tags;
    } catch (error) {
      return {
        isSuccess: false,
        res: new Error(
          `Failed to fetch tags for secret ARN: ${eventParseResult.id}`,
          {
            cause: error,
          },
        ),
      };
    }

    // filter out all autoalarm tags
    tags =
      tags && tags.length > 0
        ? (tags.filter(
            (tag): tag is {Key: string; Value: string} =>
              !!tag.Key &&
              tag.Key.startsWith('autoalarm:') &&
              typeof tag.Value === 'string',
          ) satisfies TagsObject)
        : undefined;

    // If no tags are found, return success with undefined tags
    if (!tags) {
      return {
        isSuccess: true,
        res: 'No tags found for secret',
        data: {tags: undefined},
      };
    }

    // If tags are found, return them
    return {
      isSuccess: true,
      res: 'Tags found in eventParseResult',
      data: {
        tags: tags satisfies TagsObject, // Ensure tags are of type TagsObject
      },
    };
  }

  // Helper function to fetch alarms
  private static fetchDefaultConfigs = (engine: string) => {
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

  /**
   * helper function to build alarm update options based on event type and tags
   * @template T - determines if tags are required in the options mode - uses
   * eventParseResult.hasTags @see {@link EventParseResult} for more details
   * @private
   */
  private static buildAlarmUpdateOptions<T extends boolean>(
    eventParseResult: EventParseResult,
    engine: string,
    hostID: string,
    tags: AlarmUpdateOptions<T>['mode']['tags'],
  ): AlarmUpdateOptions<T> | undefined {
    const event = eventParseResult.isCreated
      ? 'created'
      : eventParseResult.isDestroyed
        ? 'destroyed'
        : eventParseResult.eventName === 'UntagResource'
          ? 'untagged'
          : eventParseResult.eventName === 'TagResource'
            ? 'tagged'
            : null;

    // If we should have tags but they are not present, return undefined as options are in
    if (eventParseResult.hasTags && !tags) return undefined;

    if (event === null) return undefined;

    return {
      engine: engine,
      hostID: hostID,
      mode: {
        eventType: event,
        tags: tags,
      },
    };
  }

  /**
   * Function to update Prometheus rules based on the event type and tags.
   * @template T - determines if tags are required in the options mode - uses
   * eventParseResult.hasTags @see {@link EventParseResult} for more details
   * @see {@link AlarmUpdateOptions} for more details on the options structure.
   * TODO: Look into using this as a template for universal event rule
   *  routing/management
   */
  private static async prometheusRuleUpdater<T extends boolean>(
    options: AlarmUpdateOptions<T>,
  ): Promise<AlarmUpdateResult> {
    const prometheusWorkspaceId: string =
      process.env.PROMETHEUS_WORKSPACE_ID || '';

    if (!prometheusWorkspaceId) {
      return {
        isSuccess: false,
        res: new Error('Missing PROMETHEUS_WORKSPACE_ID'),
      };
    }

    // If autoAlarm is disabled or a secret is destroyed, delete all Prometheus rules for the host
    if (
      options.mode.eventType === 'disabled' ||
      options.mode.eventType === 'destroyed'
    ) {
      try {
        await deletePromRulesForService(prometheusWorkspaceId, options.engine, [
          options.hostID,
        ]);
        return {
          isSuccess: true,
          res: 'Deleted all Prometheus alarm rules for disabled autoalarm secret.',
        };
      } catch (err) {
        return {
          isSuccess: false,
          res: new Error('Failed to delete Prometheus Alarms ', {cause: err}),
        };
      }
    }

    // Get default configs for the correct DB engine (eventParseResult.engine)
    const configs = this.fetchDefaultConfigs(options.engine);

    // Big problem. If no configs are found, return early with error obj.
    if (!configs) {
      return {
        isSuccess: false,
        res: new Error(
          'No Prometheus alarm configs found for the specified engine. ' +
            'The following was returned when calling fetchPrometheusAlarmsConfig: ',
          configs,
        ),
      };
    }

    /**
     * UntagResource events only contain keys so we just grab the default values
     * autoalarm:enabled = false has already been handled. Just pull default configs
     */
    if (options.mode.eventType === 'untagged') {
      try {
        // TODO: Add logic to update alarm configs for untagged secrets
        return {
          isSuccess: true,
          res: 'Alarms successfully updated for untagged values.',
        };
      } catch (err) {
        return {
          isSuccess: false,
          res: new Error(
            'Failed to updated alarms associated with changed tag values.',
            {cause: err},
          ),
        };
      }
    }

    // If none of the conditions above are met, we must be in a TagResource event.
    // TODO
    return {
      isSuccess: false,
      res: new Error(
        'TagResource event detected, but alarm rule updater is not implemented yet. Please check logs and debug.',
      ),
    };
  }

  /**
   * Public static method which is called in main-handler to manage DB prometheus alarms
   * @param eventParseResult - The result of the event parsing, containing details about the event.
   * @see {@link EventParseResult} for more details on the structure of this object.
   */
  public static async managePromDbAlarms(
    eventParseResult: EventParseResult,
  ): Promise<boolean> {
    // Skip if CreateSecret event - Does not include tags and follow-up event with tags will follow
    if (eventParseResult.isCreated) {
      this.log
        .info()
        .str('Function', 'manageDbAlarms')
        .obj('EventParseResult', eventParseResult)
        .msg(
          'Secrets Manager sends follow up events for tags after CreateSecret event. Event handled.',
        );
      return true;
    }

    // If we have a Destroyed event, we will delete all alarms for the secret. No need to grab tags or secrets.


    // Initialize the Secrets Manager client then get host and engine
    const client = new SecretsManagerClient({
      region: process.env.AWS_REGION,
      retryStrategy: new ConfiguredRetryStrategy(
        20,
        (retryAttempt) => retryAttempt ** 2 * 500,
      ),
    });

    const {isSuccess, res, data} = this.secretsParse(
      eventParseResult.id,
      client,
    );

    // If secretsParse was unsuccessful, we cannot manage alarms. Log and return false.
    if (!resourceInfo?.isSuccess) {
      this.log
        .error()
        .str('Function', 'manageDbAlarms')
        .obj('EventParseResult', eventParseResult)
        .unknown('ResourceInfo', resourceInfo?.res)
        .msg(
          'Failed to retrieve resource info from Secrets Manager. Event not handled.',
        );
      return false;
    }

    // If secretsParse was successful but no secrets were found, exit early and return true.
    if (resourceInfo.isSuccess && !resourceInfo.data?.secretsFound) {
      this.log
        .info()
        .str('Function', 'manageDbAlarms')
        .obj('EventParseResult', eventParseResult)
        .msg(
          'No secrets found for the given ARN. Event handled without updating alarms.',
        );
      return true;
    }

    // Get tags from eventParseResult if present, otherwise fetch them from Secrets Manager
    const tags = this.fetchTags(eventParseResult, client);


    // Fall back to fetching tags from Secrets Manager if not present in eventParseResult

    // If there are not any autoAlarm tags, we are not interested
    if (!eventParseResult.isDestroyed && tags === undefined) {
      this.log
        .error()
        .str('Function', 'manageDbAlarms')
        .obj('EventParseResult', eventParseResult)
        .msg(
          'No tags found for secret in eventParseResult or via manual tag fetching. Not enabled for autoalarm. Event handled.',
        );
      return true;
    }

    // We've now filtered out any events that are not relevant to autoalarm. Create the alarm update options from eventParseResult
    const options = resourceInfo.data!.secretsFound
      ? this.buildAlarmUpdateOptions<(typeof eventParseResult)['hasTags']>(
          eventParseResult,
          resourceInfo.data.engine,
          resourceInfo.data.host,
          tags,
        )
      : undefined;

    // if options is undefined, we cannot update alarms. Log and return false.
    if (!options) {
      this.log
        .error()
        .str('Function', 'manageDbAlarms')
        .obj('EventParseResult', eventParseResult)
        .msg(
          'Failed to build alarm update options from eventParseResult. Event not handled.',
        );
      return false;
    }

    // Update Prometheus alarms based on UntagResource or TagResource events
    const alarmUpdates =
      await this.prometheusRuleUpdater<(typeof eventParseResult)['hasTags']>(
        options,
      );

    // If alarmRuleUpdater failed for untag and tag events, log the error and return false
    if (!alarmUpdates.isSuccess) {
      this.log
        .error()
        .str('Function', 'manageDbAlarms')
        .obj('EventParseResult', eventParseResult)
        .unknown('AlarmUpdateResult', alarmUpdates.res)
        .msg('Failed to update Prometheus alarms for secret.');
      return false;
    }

    // If we successfully updated all alarms, log the result and return true
    this.log
      .info()
      .str('Function', 'manageDbAlarms')
      .obj('EventParseResult', eventParseResult)
      .unknown('AlarmUpdateResult', alarmUpdates.res)
      .msg('Successfully updated Prometheus alarms for secret.');
    return true;
  }
}
