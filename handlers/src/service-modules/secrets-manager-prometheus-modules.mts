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
  ServiceEventMap,
  Tag,
  RecordMatchPairsArray,
  AMPRule,
  PromUpdateMap, PromHostInfo,
} from '../types/index.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import * as logging from '@nr1e/logging';
import {
  parseMetricAlarmOptions,
} from '../alarm-configs/utils/index.mjs';
import {buildAMPRule} from '../alarm-configs/utils/prometheus-tools-v2.mjs';

export class SecManagerPrometheusModule {
  private static oracleDBConfigs = PROMETHEUS_ORACLEDB_CONFIGS;
  private static mysqlConfigs = PROMETHEUS_MYSQL_CONFIGS;
  private static postgresConfigs = PROMETHEUS_POSTGRES_CONFIGS;
  private static log = logging.getLogger('SecManagerPrometheusModule');
  private static client = new SecretsManagerClient({
    region: process.env.AWS_REGION,
    retryStrategy: new ConfiguredRetryStrategy(
      20,
      (retryAttempt) => retryAttempt ** 2 * 500,
    ),
  });

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
    id?: string;
    engine?: string;
    host?: string;
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
   * Creates a list of {@link PromUpdatesMap} objects.
   * Utilized in the {@link fetchAutoAlarmSecrets} method.
   * @private
   */
  private static async mapSecretValues(
    autoAlarmSecrets: Array<Record<string, Tag[]>>,
  ): Promise<
    AlarmUpdateResult<{
      secretsArnMap?: PromUpdateMap;
    }>
  > {
    const secretsArns: string[] = autoAlarmSecrets.map(
      (obj) => Object.keys(obj)[0],
    );
    const secretsArnMap: PromUpdateMap = new Map();

    // BatchGetSecretValueCommand can only return 20 secrets at a time so we will need to chunk the ARNs
    const chunkSize = 20;
    const index = 0;
    let chunk = [];

    // Loop through the secretsArns in chunks of chunkSize to satisfy the limits of the BatchGetSecretValueCommand
    do {
      chunk = secretsArns.slice(index, index + chunkSize);

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
        const response: BatchGetSecretValueCommandOutput =
          await this.client.send(new BatchGetSecretValueCommand(input));

        // check if response is valid and has SecretValues
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
                  cause: `BatchGetSecretValueCommandOutput failed on ${secret.ARN}.`,
                }),
              };

            // Pull host and engine from the secretStrings object - engine is always uppercase for namespace name
            const host = secretStrings.host;
            const engine = secretStrings.engine.toUpperCase();

            // Get autoalarm tags for the current secret
            const tags = autoAlarmSecrets
              .filter((obj) => Object.hasOwn(obj, secret.ARN!))
              .map((obj) => obj[secret.ARN!])[0];

            //check if autoalarm is disabled and store in a const
            const isDisabled = tags.some(
              (tag) => tag.Key === 'autoalarm:enabled' && tag.Value === 'false',
            );

            // store 
            const mapEntry = {
              hostID: host,
              isDisabled: isDisabled,
              tags: tags,
            };

            // Ensure the engine map exists
            if (!secretsArnMap.has(engine)) {
              secretsArnMap.set(engine, new Map());
            }

            // Add the entry
            secretsArnMap.get(engine)!.set(secret.ARN!, mapEntry);

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

    // If secretsArnMap is empty, return an isSuccess
    if (secretsArnMap.size < 1) {
      return {
        isSuccess: true,
        res: 'No secrets found with autoalarm tags',
      };
    }

    // if populated return the secretsArnMap
    return {
      isSuccess: true,
      res: 'Parsed secrets from Secrets Manager',
      data: {
        secretsArnMap: secretsArnMap,
      },
    };
  }

  /**
   * Fetch all ARNs and corresponding autoalarm tags.r
   * @private
   */
  private static async fetchAutoAlarmSecrets(): Promise<
    AlarmUpdateResult<{
      secrets: Array<Record<string, Tag[]>>;
    }>
  > {
    //set next token for later use to grab all secrets
    let nextToken: string | undefined = undefined;

    // Initialize an array to hold all secrets
    const allSecrets: SecretListEntry[] = [];

    // Loop to fetch all secrets that have autoalarm tags
    try {
      do {
        const input: ListSecretsCommandInput = {
          MaxResults: 100,
          NextToken: nextToken,
        };

        // make call to list secrets
        const response = await this.client.send(new ListSecretsCommand(input));
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
      [secret.ARN!]: secret.Tags,
    })) as Array<Record<string, Tag[]>>;

    // return isSuccess if there are no autoalarm secrets so we have a logging trail
    if (secretsWithTags.length < 1) {
      return {
        isSuccess: true,
        res: 'No autoalarm secrets found with tags',
      };
    }

    // Return isSuccess and the secretsWithTags if there are autoalarm secrets
    return {
      isSuccess: true,
      res: 'Successfully fetched autoalarm secrets from Secrets Manager',
      data: {
        secrets: secretsWithTags,
      },
    };
  }

  /**
   * Helper function to fetch default values for Prometheus configs based on engine type
   * @private
   */
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

  /**
   * Helper function to build prometheus query for a given host and tag value
   * disabled alarms are filtered out in the {@link managePromDbAlarms} method
   * @private
   */
  private static async buildNamespaceDetailsMap(
    eventsSortMap: PromUpdateMap,
  ): Promise<AlarmUpdateResult> {

    const failedEngineTypes: string[] = [];
    // Get alarm values for prometheus - keys in map are the secret ARNs
    engineLoop: for (const key of eventsSortMap.keys()) {
      const configs = this.fetchDefaultConfigs(key);
      // Loop through each secret in the eventsSortMap
      secretsLoop: for (const secret of eventsSortMap.get(key)!) {
        // Failsafe if no configs are returned from fetchDefaultConfigs
        if (!configs)
          return {
            isSuccess: false,
            res: new Error('Failed to fetch configs', {
              cause: `no config match found for engine type ${eventsSortMap.get(key)!.engine}`,
            }),
          };


      // Reassign configs defaults if corresponding tag key is found
      configs.forEach((config) => {
        const tags = eventsSortMap.get(key)?.tags || [];

        const match = tags.find((tag) => tag.Key.includes(config.tagKey));
        config.defaults = parseMetricAlarmOptions(
          match?.value ?? '',
          config.defaults,
        );
      });

      // build the prometheus query for each config
      configs.forEach((config) => {
        for (const severity of [
          config.defaults.warningThreshold,
          config.defaults.criticalThreshold,
        ]) {
          config.defaults
            .prometheusExpression!.replace(
              '/_STATISTIC/',
              `${config.defaults.statistic}`,
            )
            .replace('/_THRESHOLD/', `${severity}`)
            .replace('/_HOST/', `${eventsSortMap.get(key)?.hostID}`);

          // build and add rule to the namespace details map
          const rule = buildAMPRule(
            eventsSortMap.get(key)!.engine!,
            eventsSortMap.get(key)!.hostID!,
            config,
            config.defaults.prometheusExpression!,
            severity === config.defaults.warningThreshold
              ? 'warning'
              : 'critical',
          );

          nameSpaceDetailsMap.set(eventsSortMap.get(key)!.engine!, {
            hostID: eventsSortMap.get(key)!.hostID,
            isDisabled: eventsSortMap.get(key)!.isDisabled,
            ampRule: rule.data!.ampRule,
          });
        }
      });
    }

    return {
      isSuccess: true,
      res: 'Successfully built namespace details map',
    };
  }

  /**
   * Public static method which is called in main-handler to manage DB prometheus alarms
   * @see {@link EventParseResult} for more details on the structure of this object.
   * @param eventPairs - contains an array of SQS records and their parsed event results.
   */
  public static async managePromDbAlarms(
    eventPairs: RecordMatchPairsArray,
  ): Promise<boolean> {
    // Define prometheus workspace ID and prometheus updates map
    const prometheusWorkspaceId = process.env.PROMETHEUS_WORKSPACE_ID;

    // Instantiate default namespaceUpdateMap to build rules file for each engine
    const nameSpaceDetailsMap = new Map<string, AMPRule>();
    const promUpdatesMap: PromUpdateMap = new Map();

    // Validate that the prometheus workspace ID is set
    if (!prometheusWorkspaceId) {
      this.log
        .error()
        .str('Function', 'managePromDbAlarms')
        .msg('Prometheus workspace ID is not set in environment variables.');
      return false;
    }

    /**
     * because we're updating all prometheus rules for any secret that is tagged, we don't care about event type.
     */

    // if there is are any destroyed events, we need to fetch the host/engine from dynamoDB then add to the prometheus updates map
    for (const pair of eventPairs.filter(
      (pair) => pair.eventParseResult.isDestroyed,
    )) {
      const {eventParseResult} = pair;
      const destroyedInfo = this.dynamoDBFetch(eventParseResult.id);
      if (destroyedInfo.isSuccess && destroyedInfo.data?.alarmsFound) {
        promUpdatesMap.set(destroyedInfo.data.id!, {
          engine: destroyedInfo.data.engine!,
          hostID: destroyedInfo.data.host!,
          isDisabled: true,
          tags: [],
        });
      }

      // If we can't fetch dynamoDB data for destroyed events, log and return false
      if (!destroyedInfo.isSuccess) {
        this.log
          .error()
          .str('Function', 'dynamoDBFetch')
          .unknown('DynamoDBFetchError', destroyedInfo.res)
          .msg(
            'Failed to fetch DynamoDB data for destroyed secret. Cannot proceed.',
          );
        return false;
      }
    }

    /**
     * All following events are UntagResource and TagResource type events.
     *   1. Get the secret ARN from the eventParseResult and fetch tags for every secret that is staged with autoalarm tags.
     *   2. Get host and engine secret from every autoalarm tagged secret. Log warning if host or engine is not found with for later debug.
     *   3. Get configs and build nameSpaceUpdate object (NameSpaceDetails Interface) @see {@link NameSpaceDetails}.
     *   4. Compare each rule group in the nameSpaceUpdate map with the existing presentNameSpaceRules map.
     *   5. If any divergence is found any rule group, update the prometheus rules for the entire rule group.
     *   6. replace  with latest updates for following event lookup.
     */

    // fetch a list of secrets with autolarm tags and then attempt to map secret values for host and engine
    const autoAlarmSecrets = await this.fetchAutoAlarmSecrets();
    const tagSecretsMap = autoAlarmSecrets.data
      ? await this.mapSecretValues(autoAlarmSecrets.data.secrets)
      : undefined;

    // Log if fetchAutoAlarmSecrets or mapSecretValues failed
    if (!autoAlarmSecrets.isSuccess || !tagSecretsMap?.isSuccess) {
      this.log
        .error()
        .str(
          'Function',
          !autoAlarmSecrets.isSuccess
            ? 'fetchAutoAlarmSecrets'
            : 'mapSecretValues',
        )
        .unknown(
          'Fetched Secrets/SecretValues Error',
          !autoAlarmSecrets.isSuccess
            ? autoAlarmSecrets.res
            : tagSecretsMap?.res,
        )
        .msg(
          'Failed to fetch Secrets and secret values for Prometheus Alarm creation.',
        );
      return false;
    }

    // Log if fetchAutoAlarmSecrets or mapSecretValues returned no secrets/secretValues but was successful
    if (
      (autoAlarmSecrets.isSuccess && !autoAlarmSecrets.data) ||
      (tagSecretsMap.isSuccess && !tagSecretsMap.data)
    ) {
      this.log
        .info()
        .str(
          'Function',
          !autoAlarmSecrets.isSuccess
            ? 'fetchAutoAlarmSecrets'
            : 'mapSecretValues',
        )
        .obj(
          'FetchTagsError',
          autoAlarmSecrets ? autoAlarmSecrets : tagSecretsMap,
        )
        .msg('No autoalarm secrets found with tags.');
    }

    // If we have secrets, let's put them into the prometheus updates map but log warning and filter out any secrets that do not have hostID or engine
    tagSecretsMap.data
      ? tagSecretsMap.data.secretsArnMap!.forEach((V, K) => {
          if (!V.hostID || !V.engine) {
            this.log
              .warn()
              .str('Function', 'managePromDbAlarms')
              .obj('SecretARN', {ARN: K, ...V})
              .msg(
                'AutoAlarm Tagged Secret does  not have hostID or engine secret string. Skipping Alarm Management.',
              );

            tagSecretsMap.data?.secretsArnMap!.delete(K); // Remove from tagSecretsMap

            return; // Skip this secret
          }

          promUpdatesMap.set(K, V); // Add to prometheus updates map
        })
      : undefined;

    // clean up tagSecretsMap now that we moved the secrets to the prometheus updates map
    tagSecretsMap.data ? delete tagSecretsMap.data : undefined;

    // Remove any secrets that are disabled from the prometheus updates map
    const autoAlarmDisabledSecrets: string[] = [];
    promUpdatesMap.forEach((value, key) => {
      if (value.isDisabled) {
        autoAlarmDisabledSecrets.push(key);
        promUpdatesMap.delete(key);
      }
    });

    if (autoAlarmDisabledSecrets.length > 0) {
      this.log
        .info()
        .str('Function', 'managePromDbAlarms')
        .obj('DisabledSecrets', autoAlarmDisabledSecrets)
        .msg(
          'AutoAlarm is disabled for the following secrets. These secrets will not be included in the new ruleset.',
        );
    }

    // If we successfully processed all secrets, log and return true
    this.log
      .info()
      .str('Function', 'managePromDbAlarms')
      .obj('ProcessedSecrets', filteredSecrets)
      .msg('Successfully processed all secrets and updated prometheus.');

    return true;
  }
}
