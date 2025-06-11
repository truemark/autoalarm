import {
  SecretsManagerClient,
  ListSecretsCommandInput,
  SecretListEntry,
  ListSecretsCommand,
  BatchGetSecretValueCommand,
  BatchGetSecretValueCommandInput,
  BatchGetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager';
import {
  PROMETHEUS_MYSQL_CONFIGS,
  PROMETHEUS_ORACLEDB_CONFIGS,
  PROMETHEUS_POSTGRES_CONFIGS,
} from '../alarm-configs/index.mjs';
import {
  AlarmUpdateResult,
  EventParseResult,
  MetricAlarmConfig,
  ServiceEventMap,
  TagsObject,
  NamespaceDetails,
  RuleGroup,
  DbEngine,
  Tag,
  PromUpdatesMap,
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
  private static nameSpaceDetails: NamespaceDetails = {groups: []};

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

  /**
   * Dynamo DB fetcher to check for instances of alarms for a secret when it is
   * destroyed, and we can't get the host and engine from the secret.
   * TODO: Belongs in dynamoDB utils file. Temp.
   */
  private static dynamoDBFetch(arn: string): AlarmUpdateResult<{
    id: string;
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
        id: arn,
        engine: 'mysql', // Example engine
        host: 'example-host', // Example host
        alarmsFound: true,
      },
    };
  }

  /**
   * Parses secrets from the Secrets Manager and retrieves engine and host information.
   * Creates a list of {@link MassPromUpdatesMap} objects.
   * Utilized in the {@link fetchAutoAlarmSecrets} method.
   * @param autoAlarmSecrets
   * @private
   */
  private static parseSecrets(
    autoAlarmSecrets: {[arn: string]: Tag[]},
    client: SecretsManagerClient,
  ): AlarmUpdateResult<{
    secretsArnMap?: PromUpdatesMap;
  }> {
    const secretsArns: string[] = Object.keys(autoAlarmSecrets);
    const secretsArnMap: PromUpdatesMap = new Map();

    // BatchGetSecretValueCommand can only return 20 secrets at a time so we will need to chunk the ARNs
    const chunkSize = 20;
    const index = 0;

    do {
      const chunk = secretsArns.slice(index, index + chunkSize - 1);

      const input: BatchGetSecretValueCommandInput = {
        SecretIdList: chunk,
        Filters: [
          {
            Key: 'name',
            Values: ['host', 'engine'],
          },
        ],
      };

      try {
        const response: BatchGetSecretValueCommandOutput = await client.send(
          new BatchGetSecretValueCommand(input),
        );

        if (response && response.SecretValues) {
          for (const secret of Object.values(response.SecretValues)) {
            // AWS is dumb so we need to parse the secret string to a json object because it's 'enclosed' in single quotes
            const secretStrings = secret.SecretString
              ? JSON.parse(secret.SecretString)
              : undefined;

            // If the secret object is not found, return an error result
            if (!secretStrings)
              return {
                isSuccess: false,
                res: new Error(`Failed to batch get secrets.`, {
                  cause: `BatchGetSecretValueCommandOutput failed on ${autoAlarmSecrets.arn}.`,
                }),
              };

            // Pull host and engine from the secretStrings object
            const host = secretStrings.host;
            const engine = secretStrings.engine;

            // If either host or engine is not found, return an error result
            if (!host || !engine)
              return {
                isSuccess: false,
                res: new Error(`Failed to batch get secrets.`, {
                  cause: `BatchGetSecretValueCommandOutput failed on ${autoAlarmSecrets.arn}. Host or engine not found.`,
                }),
              };

            // Add entry in the secretsArnMap
            secretsArnMap.set(secret.ARN!, {
              engine: engine,
              hostID: host,
              isDisabled: autoAlarmSecrets[secret.ARN!].some(
                (t) => t.Key === 'autoalarm:enabled' && t.Value === 'false',
              ),
              tags: autoAlarmSecrets[secret.ARN!],
              ruleGroup: engine,
            });
          }
        }
      } catch (err) {
        return {
          isSuccess: false,
          res: new Error('Failed to batch get secrets from Secrets Manager', {
            cause: err,
          }),
        };
      }
    } while (index < secretsArns.length);

    // return the secretsArnMap
    return {
      isSuccess: true,
      res: 'Parsed secrets from Secrets Manager',
      data: {
        secretsArnMap: secretsArnMap.size > 0 ? secretsArnMap : undefined,
      },
    }
  }

  /**
   * Fetch all ARNs and corresponding autoalarm tags.r
   * @private
   */
  private static async fetchAutoAlarmSecrets(
    client: SecretsManagerClient,
  ): Promise<
    AlarmUpdateResult<{
      //foundSecrets: boolean;
      autoalarmSecrets: Record<string, TagsObject>[];
    }>
  > {
    //set next token for later use to grab all secrets
    let nextToken: string | undefined = undefined;

    // Initialize an array to hold all secrets
    const allSecrets: SecretListEntry[] = [];

    // 1. Fetch all secrets in a loop until there are no more pages, then filter out secrets with autoalarm tags
    try {
      do {
        const input: ListSecretsCommandInput = {
          MaxResults: 100,
          NextToken: nextToken,
        };

        // make call to list secrets
        const response = await client.send(new ListSecretsCommand(input));
        allSecrets.push(...(response.SecretList ?? []));
        nextToken = response.NextToken;
      } while (nextToken);
    } catch (err) {
      return {
        isSuccess: false,
        res: new Error('Failed to fetch secrets from Secrets Manager', {
          cause: err,
        }),
      };
    }

    // Filter secrets to find those with autoalarm tags
    const autoalarmSecrets = allSecrets.filter((secret) => {
      return secret.Tags?.some(
        (tag): tag is {Key: string; Value: string} =>
          !!tag.Key && tag.Key.startsWith('autoalarm:'),
      );
    });

    const secretsWithTags = autoalarmSecrets.map((secret) => ({
      arn: secret.ARN,
      tags: secret.Tags,
    })) as unknown as Record<string, TagsObject>[];

    // return isSuccess if there are no autoalarm secrets so we have a logging trail
    if (secretsWithTags.length < 1) {
      return {
        isSuccess: true,
        res: 'No autoalarm secrets found with tags',
        data: {
          autoalarmSecrets: [],
        },
      };
    }



    // If tags are found, return them
    return {
      isSuccess: true,
      res: 'Fetched all autoalarm secrets with tags',
      data: {
        autoalarmSecrets: [...secretsWithTags],
      },
    };
  }

  // Helper function to fetch default values for Prometheus configs based on engine type
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
   * Handle Destroyed Events
   */
  private static async handleDestroyedAndDisabled(
    prometheusWorkspaceId: string,
    engine: string,
    hostID: string,
  ): Promise<AlarmUpdateResult> {
    // some service events may not need to action this event type. Ideally these would be removed from the event map

    // Try to handle the destroyed event by deleting all Prometheus rules for the host
    try {
      await deletePromRulesForService(prometheusWorkspaceId, engine, [hostID]);
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

  private static updateNameSpaceDetails(
    nameSpaceDetails: NamespaceDetails,
  ): NamespaceDetails {
    return {
      groups: [
        {
          name: 'autoalarm',
          rules: [],
        },
      ],
    };
  }

  /**
   * Compare two NamespaceDetails objects and update the rule groups if they differ.
   * @param nameSpaceDetails - The current namespace details.
   * @param updateDetails - The updated namespace details to compare against.
   */
  private static compareAndUpdateRuleGroups(
    updateDetails: NamespaceDetails,
  ): AlarmUpdateResult<{
    updatedRuleGroups: RuleGroup[];
  }> {
    const updatedRuleGroups: RuleGroup[] = Object.values(updateDetails);
  }

  /**
   * Public static method which is called in main-handler to manage DB prometheus alarms
   * @param eventParseResult - The result of the event parsing, containing details about the event.
   * @see {@link EventParseResult} for more details on the structure of this object.
   */
  public static async managePromDbAlarms(
    eventParseResult: EventParseResult,
  ): Promise<boolean> {
    // Define prometheus workspace ID
    const prometheusWorkspaceId = process.env.PROMETHEUS_WORKSPACE_ID;

    // Validate that the prometheus workspace ID is set
    if (!prometheusWorkspaceId) {
      this.log
        .error()
        .str('Function', 'managePromDbAlarms')
        .msg('Prometheus workspace ID is not set in environment variables.');
      return false;
    }

    // Skip if CreateSecret event - Does not include tags and follow-up event with tags will follow
    if (eventParseResult.isCreated) {
      this.log
        .info()
        .str('Function', 'manageDbAlarms')
        .obj('EventParseResult', eventParseResult)
        .msg(
          'Secrets Manager sends follow up events for tags after CreateSecret event. No Action required.',
        );
      return true;
    }

    // Handle Destroyed events (delete alarms, fetch info first)
    if (eventParseResult.isDestroyed) {
      const destroyedInfo = this.dynamoDBFetch(eventParseResult.id);

      // Early exit on failed fetch
      if (!destroyedInfo?.isSuccess) {
        this.log
          .error()
          .str('Function', 'manageDbAlarms')
          .unknown('DynamoDBFetchError', destroyedInfo?.res)
          .msg(
            'Failed to fetch DynamoDB data for destroyed secret. Cannot proceed.',
          );
        return false;
      }

      // Success fetch: log and process if alarms found
      this.log
        .info()
        .str('Function', 'manageDbAlarms')
        .obj('DynamoDBFetchSuccess', destroyedInfo.data)
        .msg('Successfully fetched DynamoDB data for destroyed secret.');

      if (destroyedInfo.data?.alarmsFound) {
        const result = await this.handleDestroyedAndDisabled(
          prometheusWorkspaceId,
          destroyedInfo.data.host!,
          destroyedInfo.data.engine!,
        );

        // If the result is not successful, log the error and return false
        if (!result.isSuccess) {
          this.log
            .error()
            .str('Function', 'handleDestroyedAndDisabled')
            .obj('HandleDestroyedError', result)
            .msg('Failed to handle destroyed event.');
          return false;
        }
      }
      // All work for destroyed event is done
      return true;
    }

    /**
     * All following events are UntagResource and TagResource type events.
     *   1. Get the secret ARN from the eventParseResult and fetch tags for every secret that is taged with autoalarm tags.
     *   2. Get host and engine secret from every autoalarm tagged secret. Log warning if host or engine is not found with for later debug.
     *   3. Get configs and build nameSpaceUpdate object (NameSpaceDetails Interface) @see {@link NameSpaceDetails}.
     *   4. Compare each rule group in the nameSpaceUpdate map with the existing presentNameSpaceRules map.
     *   5. If any divergence is found any rule group, update the prometheus rules for the entire rule group.
     *   6. replace  with latest updates for following event lookup.
     */

    // Instantiate default namespaceUpdateMap
    const nameSpaceUpdateMap: NamespaceDetails<DbEngine> = {groups: []};

    // Get all autoalarm tagged secrets from Secrets Manager
    const AutoAlarmSecrets = await this.fetchAutoAlarmSecrets(
      new SecretsManagerClient({
        region: process.env.AWS_REGION,
        retryStrategy: new ConfiguredRetryStrategy(
          20,
          (retryAttempt) => retryAttempt ** 2 * 500,
        ),
      }),
    );

    if (!AutoAlarmSecrets.isSuccess) {
      this.log
        .error()
        .str('Function', 'fetchAutoAlarmSecrets')
        .unknown('FetchTagsError', AutoAlarmSecrets.res)
        .msg('Failed to fetch Secrets.');
      return false;
    }

    if (
      AutoAlarmSecrets.isSuccess &&
      AutoAlarmSecrets.data &&
      AutoAlarmSecrets.data.autoalarmSecrets.length < 1
    ) {
      this.log
        .info()
        .str('Function', 'fetchAutoAlarmSecrets')
        .obj('AutoAlarmSecrets', AutoAlarmSecrets.data)
        .msg('No autoalarm secrets found.');
      return true;
    }

    // Build a map of secrets with all the info needed to update Prometheus alarms
    const prometheusUpdateMap: MassPromUpdatesMap = {};

    // Get all host/engine secrets for autoalarm tagged secrets
    for (const {secretArn, engine} of AutoAlarmSecrets.data!.autoalarmSecrets) {
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

    return true;
  }
}
