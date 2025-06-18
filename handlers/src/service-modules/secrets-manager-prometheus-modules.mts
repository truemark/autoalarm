import {
  SecretsManagerClient,
  ListSecretsCommandInput,
  SecretListEntry,
  ListSecretsCommand,
  BatchGetSecretValueCommand,
  BatchGetSecretValueCommandInput,
  ListSecretsCommandOutput,
} from '@aws-sdk/client-secrets-manager';
import {
  PROMETHEUS_MYSQL_CONFIGS,
  PROMETHEUS_ORACLEDB_CONFIGS,
  PROMETHEUS_POSTGRES_CONFIGS,
} from '../alarm-configs/index.mjs';
import {
  AlarmUpdateResult,
  ServiceEventMap,
  RecordMatchPairsArray,
  NamespaceDetailsMap,
  PromUpdateMap,
  PromHostInfoMap,
  TagV2, MetricAlarmConfig, NameSpaceDetails, RequiredPromHostInfo
} from '../types/index.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import * as logging from '@nr1e/logging';
import {parseMetricAlarmOptions} from '../alarm-configs/utils/index.mjs';
import {buildAMPRule} from '../alarm-configs/utils/prometheus-tools-v2.mjs';
import {string} from 'valibot';

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
    promHostInfoMap: PromHostInfoMap,
    promUpdateMap: PromUpdateMap,
  ): Promise<AlarmUpdateResult> {
    // Grab ARNs from the autoAlarmSecrets map
    const secretsArns = Array.from(promHostInfoMap.keys());

    // BatchGetSecretValueCommand can only return 20 secrets at a time so we will need to chunk the ARNs
    const chunks = Array.from(
      {length: Math.ceil(secretsArns.length / 20)},
      (_, i) => secretsArns.slice(i * 20, (i + 1) * 20),
    );

    // parallel process the secretsArns in chunks - Secrets Manager allows up to 20 secrets per BatchGetSecretValueCommand
    const chunkPromises = chunks.map(async (chunk) => {
      const input: BatchGetSecretValueCommandInput = {
        SecretIdList: chunk,
        Filters: [{Key: 'name', Values: ['host', 'engine']}],
      };

      const response = await this.client.send(
        new BatchGetSecretValueCommand(input),
      );
      return response.SecretValues || [];
    });

    try {
      // await all promises and then put them into an array for easy wrangling
      const allResults = await Promise.all(chunkPromises);
      const allSecrets = allResults.flat();

      // Process each secret to extract host and engine information
      for (const secret of allSecrets) {
        if (!secret.SecretString || !secret.ARN) continue;

        const secretString = JSON.parse(secret.SecretString);
        const tags = promHostInfoMap.get(secret.ARN)!.tags;

        // Check if host and engine secrets are present
        if (!secretString?.host || !secretString?.engine || !tags) continue;

        // Extract host and engine from the secret data. Convert engine to uppercase for rule group namespace name
        const engine = secretString.engine.toUpperCase();
        const isDisabled = tags.some(
          (tag) => tag.Key === 'autoalarm:enabled' && tag.Value === 'false',
        );

        // build promUpdateMap
        !promUpdateMap.has(engine)
          ? promUpdateMap.set(engine, new Map())
          : void 0;

        promUpdateMap.get(engine)!.set(secret.ARN, {
          hostID: secretString.host,
          isDisabled: isDisabled,
          tags: tags,
        });
      }

      // return success if
      return promUpdateMap.size
        ? {
            isSuccess: true,
            res: 'Parsed secrets from Secrets Manager. Map has been updated',
          }
        : {
            isSuccess: false,
            res: new Error('No secrets found with autoalarm tags', {
              cause: allSecrets,
            }),
          };
    } catch (err) {
      return {
        isSuccess: false,
        res: new Error('Failed to map secret values from Secrets Manager', {
          cause: err,
        }),
      };
    }
  }

  /**
   * Fetch all ARNs and corresponding autoalarm tags.r
   * @private
   */
  private static async fetchAutoAlarmSecrets(
    promHostInfoMap: PromHostInfoMap,
  ): Promise<AlarmUpdateResult> {
    const allSecrets: SecretListEntry[] = [];
    let nextToken: string | undefined = undefined;

    // Loop through secrets to get all secrets and tags
    try {
      do {
        const response: ListSecretsCommandOutput = await this.client.send(
          new ListSecretsCommand({
            MaxResults: 100,
            NextToken: nextToken,
          }),
        );

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

    // Massage secrets into a shape we can use to inject into promUpdatesMap and filter out non-autolarm secrets
    allSecrets.forEach((secret) => {
      // reduce secrets to only autoalarm tagged secrets
      const autoAlarmTags = secret.Tags?.reduce<TagV2[]>((acc, tag) => {
        if (tag.Key?.includes('autoalarm:')) {
          acc.push(tag as TagV2);
        }
        return acc;
      }, []);

      // If there are any autoalarm tags, add the secret to the promHostInfoMap
      autoAlarmTags?.length
        ? promHostInfoMap.set(secret.ARN!, {tags: autoAlarmTags})
        : void 0;
    });

    // Return isSuccess and the secretsWithTags if there are autoalarm secrets
    return {
      isSuccess: true,
      res: 'Successfully fetched autoalarm secrets from Secrets Manager. PromHostInfoMap has been updated.',
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
    promUpdateMap: PromUpdateMap,
  ): Promise<AlarmUpdateResult> {

    for (const [engine, hostInfoMap] of promUpdateMap.entries()) {

      const configs = this.fetchDefaultConfigs(engine);

      if (!configs) {
        return {
          isSuccess: false,
          res: new Error(`Could not fetch configs for engine: ${engine}`),
        };
      }

      // add default configs to each host in each namespace(engine)
        hostInfoMap.forEach((info, arn) => {
            hostInfoMap.set(arn, {
            ...info,
            configs: configs,
            });
        });

      // Get AMP Rules for each host in each namespace(engine)
      const result = this.processHostRules(engine, hostInfoMap);



    }

    return {
      isSuccess: true,
      res: 'Successfully built namespace details map',
    };
  }

  private static processHostRules(
    engine: string,
    hostInfo: PromHostInfoMap,
  ): void {
    // Build Array Object to hold configs for tag overrides
    const arn: string = hostInfo.keys().next().value!;
    const configs = hostInfo.get(arn)?.configs;
    const processedConfigs = this.applyTagOverrides(hostInfo.get(arn)?.tags!, configs);

    // Generate Prometheus expressions and rules for each config
    for (const config of processedConfigs) {

        const result = buildAMPRule(
          engine,
          hostInfo.get(arn)!.hostID as string, //we know this is safe as we filtered out any missing values earlier
          config,
          config.defaults.prometheusExpression,
        );
        const ampRules = result.data?.ampRules


        // Add the rule to the hostInfoMap
      hostInfo.set(arn, {
        ...hostInfo.get(arn),
      ampRules: ampRules
      });
    }
  }

  private static applyTagOverrides(tags: TagV2[], configs: any[]): any[] {
    return configs.map(config => {
      const configCopy = { ...config };
      const match = tags.find(tag => tag.Key?.includes(config.tagKey));

      if (match) {
        configCopy.defaults = parseMetricAlarmOptions(match.Value ?? '', config.defaults);
      }

      return configCopy;
    });
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
    const promHostInfoMap: PromHostInfoMap = new Map();
    const promUpdatesMap: PromUpdateMap = new Map();
    const namespaceDetailsMap: NamespaceDetailsMap = new Map();

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
        promUpdatesMap.set(destroyedInfo.data.engine!, new Map());
        promUpdatesMap.get(destroyedInfo.data.engine!)!.set(
          destroyedInfo.data.id!,
          {
            hostID: destroyedInfo.data.host,
            isDisabled: true, // Assume not disabled for destroyed events
          },
        );

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

    // fetch a list of secrets with autolarm tags and then attempt to map secret values for host and engine
    const autoAlarmSecrets = await this.fetchAutoAlarmSecrets(promHostInfoMap);
    const tagSecretsMap = autoAlarmSecrets.data
      ? await this.mapSecretValues(promHostInfoMap, promUpdatesMap)
      : undefined;

    // clean up promHostInfoMap now that we moved the secrets to the prometheus updates map
    promHostInfoMap.clear();

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


    // Remove any secrets that are disabled from the prometheus updates map
    const autoAlarmDisabledSecrets: string[] = [];

    Object.keys(promUpdatesMap).forEach((engine) => {
      const hostInfoMap = promUpdatesMap.get(engine)!;
      hostInfoMap.forEach((info, arn) => {
        if (info.isDisabled) {
          autoAlarmDisabledSecrets.push(arn);
          hostInfoMap.delete(arn);
        }
      });

      // If no hosts are left for the engine, delete the engine from the map
      if (!hostInfoMap.size) promUpdatesMap.delete(engine);

    })

    // First, let's build the PromUpdatesMap with the alert rules for each engine/host




    if (autoAlarmDisabledSecrets.length) {
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
