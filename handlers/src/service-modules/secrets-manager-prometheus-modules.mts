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

  /**
   * Dynamo DB fetcher to check for instances of alarms for a secret when it is
   * destroyed, and we can't get the host and engine from the secret.
   * TODO: Belongs in dynamoDB utils file. Temp.
   */
  private static dynamoDBFetch(arn: string): AlarmUpdateResult<{
    arn: string;
    engine: string | undefined;
    host: string | undefined;
    alarmsFound: boolean;
  }> {
    // This function is a placeholder for the actual DynamoDB fetch logic.
    // It should return an object with engine, host, and secretsFound properties.
    // For now, we will return a dummy object.
    return {
      isSuccess: true,
      res: 'DynamoDB fetch not implemented',
      data: {
        arn: arn,
        engine: 'mysql', // Example engine
        host: 'example-host', // Example host
        alarmsFound: true,
      },
    };
  }

  // Helper Function to fetch tags from Secrets Manager if eventParseResult does not have them
  private static async fetchTags(
    parsed: EventParseResult,
    client: SecretsManagerClient,
  ): Promise<
    AlarmUpdateResult<{
      tags?: TagsObject | undefined;
      isRemoved?: boolean;
      isFallback?: boolean;
      isAdded?: boolean;
    }>
  > {
    let fetchedTags;
    // first check if the eventParsed result has tags and use them if it does
    const parsedTags: TagsObject | undefined = parsed.hasTags
      ? parsed.tags
      : undefined;

    // If no tags in eventParseResult, try to fetch them from Secrets Manager
    if (!parsedTags) {
      try {
        fetchedTags = (
          await client.send(
            new DescribeSecretCommand({SecretId: parsed.id}),
          )
        ).Tags;

        // filter out all autoalarm tags
        fetchedTags =
          fetchedTags && fetchedTags.length > 0
            ? (fetchedTags.filter(
                (tag): tag is {Key: string; Value: string} =>
                  !!tag.Key &&
                  tag.Key.startsWith('autoalarm:') &&
                  typeof tag.Value === 'string',
              ) satisfies TagsObject)
            : undefined;
      } catch (error) {
        return {
          isSuccess: false,
          res: new Error(
            `Failed to fetch tags for secret ARN: ${parsed.id}`,
            {
              cause: error,
            },
          ),
        };
      }
    }

    // If no tags are found, return success with undefined tags
    if (!parsedTags && !fetchedTags) {
      return {
        isSuccess: true,
        res: 'No tags found for secret. Please review lambda logs and debug.',
        data: {tags: undefined},
      };
    }

    // set constants for return object
    const tags = parsedTags ? parsedTags : fetchedTags;
    const isRemoved = (parsed.eventName === 'UntagResource' && tags !== fetchedTags);
    const isAdded = (parsed.eventName === 'TagResource' && tags !== fetchedTags);
    const isFallback = tags === fetchedTags;


    // If tags are found, return them
    return {
      isSuccess: true,
      res: 'Tags Identified',
      data: {
        tags: tags,
        isRemoved: isRemoved,
        isAdded: isAdded,
        isFallback: isFallback,
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
  ): AlarmUpdateResult<{options?: AlarmUpdateOptions<T>}> {
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
    if (eventParseResult.hasTags && !tags) {
      return {
        isSuccess: false,
        res: 'Tags are required but not present in eventParseResult.',
      };
    }

    if (event === null)
      return {
        isSuccess: false,
        res: 'Event type not recognized or not handled.',
      };

    return {
      isSuccess: true,
      res: 'Alarm update options built successfully.',
      data: {
        options: {
          engine,
          hostID,
          mode: {
            eventType: event,
            tags: tags,
          },
        } satisfies AlarmUpdateOptions<T>,
      },
    };
  }

  /**
   * Handle Create Events
   */
  private static async handleCreatedt<T extends boolean>(
    options: AlarmUpdateOptions<T>,
  ): Promise<AlarmUpdateResult<{options: AlarmUpdateOptions<T>}>> {
    // Many services create events do not need action and are followed by TagResource events
    //Placeholder for any create event handling logic

    return {
      isSuccess: false,
      res: 'Create event not handled, no options provided. and shouldPass is false.',
      data: {
        options: options,
      },
    };
  }

  /**
   * Handle Destroyed Events
   */
  private static async handleDestroyedAndDisabled<T extends boolean>(
    prometheusWorkspaceId: string,
    options: AlarmUpdateOptions<T>,
  ): Promise<AlarmUpdateResult> {
    // some service events may not need to action this event type. Ideally these would be removed from the event map

    // Try to handle the destroyed event by deleting all Prometheus rules for the host
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

  /**
   * Handle all tagged events, including TagResource and UntagResource
   * @param prometheusWorkspaceId - The ID of the Prometheus workspace.
   * @param options - The options for the alarm update, including engine and host ID.
   * @param tags - The tags associated with the event, which can be undefined if not present.
   * @param isRemoved - Indicates if the tags were removed AND found in the parsed event(UntagResource event).
   * @param isAdded - Indicates if the tags were added AND found in the Parsed Event (TagResource event).
   * @param isFallback - Indicates if the tags were fetched from Secrets Manager instead of the eventParseResult.
   * requiring that we rebuild all the alarms for the host and engine vs. just what was changed.
   */
  private static async handleTags<T extends boolean>(
    prometheusWorkspaceId: string,
    options: AlarmUpdateOptions<T>,
    tags: TagsObject,
    isRemoved?: boolean,
    isAdded?: boolean,
    isFallback?: boolean,
  ): Promise<AlarmUpdateResult> {
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

    // Untagged (isRemoved) events management



    //Once we have the configs, we can rebuild the Prometheus rules
    for (const config of configs) {
    }
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
