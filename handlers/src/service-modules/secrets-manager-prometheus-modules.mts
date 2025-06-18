import {
  BatchGetSecretValueCommand,
  BatchGetSecretValueCommandInput,
  ListSecretsCommand,
  ListSecretsCommandInput,
  ListSecretsCommandOutput,
  SecretListEntry,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  PROMETHEUS_MYSQL_CONFIGS,
  PROMETHEUS_ORACLEDB_CONFIGS,
  PROMETHEUS_POSTGRES_CONFIGS,
} from '../alarm-configs/index.mjs';
import {
  MetricAlarmConfig,
  NamespaceDetailsMap,
  PromHostInfoMap,
  PromUpdateMap,
  RecordMatchPairsArray,
  ServiceEventMap,
  TagV2,
} from '../types/index.mjs';
import {ModUtil} from '../../src/service-modules/utils/index.mjs';
import {ConfiguredRetryStrategy} from '@smithy/util-retry';
import * as logging from '@nr1e/logging';
import {parseMetricAlarmOptions} from '../alarm-configs/utils/index.mjs';
import {buildAMPRule} from '../alarm-configs/utils/prometheus-tools-v2.mjs';

export class SecManagerPrometheusModule {
  private static oracleDBConfigs = PROMETHEUS_ORACLEDB_CONFIGS;
  private static mysqlConfigs = PROMETHEUS_MYSQL_CONFIGS;
  private static postgresConfigs = PROMETHEUS_POSTGRES_CONFIGS;
  private static util = new ModUtil(
    logging.getLogger('SecManagerPrometheusModule'),
  );
  private static log = this.util.log;
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
  private static dynamoDBFetch(arn: string): {
    arn?: string;
    engine?: string;
    host?: string;
    alarmsFound: boolean;
  } {
    // This function is a placeholder for the actual DynamoDB fetch logic.
    // It should return an object with engine, host, and secretsFound properties.
    // For now, we will return a dummy object.
    this.log('info', 'dynamoDBFetch', 'DynamoDB fetch not implemented', {
      arn: arn,
      engine: 'mysql', // Example engine
      host: 'example-host', // Example host
      alarmsFound: true,
    });

    return {
      arn: arn,
      engine: 'mysql', // Example engine
      host: 'example-host', // Example host
      alarmsFound: true,
    };
  }

  /**
   * Parses secrets from the Secrets Manager and retrieves engine and host information.
   * Utilized in the {@link fetchSecretTags} method.
   * @private
   */
  private static async mapSecretValues(
    promHostInfoMap: PromHostInfoMap,
    promUpdateMap: PromUpdateMap,
  ) {
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
          host: secretString.host,
          isDisabled: isDisabled,
          tags: tags,
        });
      }

      // return success if

      promUpdateMap.size
        ? this.util.log(
          'info',
          'mapSecretValues',
          'Mapped secret values from Secrets Manager',
          {mappedSecrets: promUpdateMap.size},
        )
        : this.util.log(
          'error',
          'mapSecretValues',
          "'No secrets found with autoalarm tags'",
          {cause: allSecrets},
        );
    } catch (err) {
      this.util.log(
        'error',
        'mapSecretValues',
        'Failed to map secret values from Secrets Manager',
        {cause: err},
      );
      throw err;
    }
  }

  /**
   * Fetch all ARNs and corresponding autoalarm tags.r
   * @private
   */
  private static async fetchSecretTags(promHostInfoMap: PromHostInfoMap) {
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
      this.util.log(
        'error',
        'fetchAutoAlarmSecrets',
        'Failed to fetch secrets from Secrets Manager',
        {cause: err},
      );
      throw err;
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
      this.util.log(
        'error',
        'fetchSecretTags',
        'Failed to fetch secrets from Secrets Manager',
        {cause: err},
      );
      throw err;
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
    this.util.log(
      'info',
      'fetchSecretTags',
      'Fetched secrets from Secrets Manager',
      {fetchedSecrets: promHostInfoMap.size},
    );
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
  private static addHostConfigsToMap(promUpdateMap: PromUpdateMap) {
    for (const [engine, hostInfoMap] of promUpdateMap.entries()) {
      const configs = this.fetchDefaultConfigs(engine);

      if (!configs) {
        this.util.log('error', 'buildNamespaceDetailsMap', 'No configs found');
        throw new Error(`Could not fetch configs for engine: ${engine}`);
      }

      // add default configs to each host in each namespace(engine)
      hostInfoMap.forEach((info, arn) => {
        hostInfoMap.set(arn, {
          ...info,
          configs: configs,
        });
      });
    }
    this.util.log(
      'info',
      'buildNamespaceDetailsMap',
      'Successfully built namespace details map',
    );
  }

  private static addAmpRulesToMap(
    engine: string,
    hostInfo: PromHostInfoMap,
  ): void {
    // Build Array Object to hold configs for tag overrides
    const arn: string = hostInfo.keys().next().value!;
    const configs = hostInfo.get(arn)?.configs as MetricAlarmConfig[];

    // Generate Prometheus expressions and rules for each config
    for (const config of configs) {
      const ampRules = buildAMPRule(
        engine,
        hostInfo.get(arn)!.host ?? '',
        config,
        config.defaults.prometheusExpression!,
      );

      // Add the rule to the hostInfoMap
      hostInfo.set(arn, {
        ...hostInfo.get(arn),
        ampRules: ampRules,
      });
    }
    this.util.log(
      'info',
      'addAmpRulesToMap',
      'Successfully processed host rules/tag overrides if present',
      {engine, HostInfo: hostInfo},
    );
  }

  // Update configs with tag overrides if present in PromHostInfoMap
  private static applyTagOverrides(
    configs: MetricAlarmConfig[],
    hostInfo: PromHostInfoMap,
  ) {
    const arn = hostInfo.keys().next().value ?? '';
    const tags = hostInfo.get(arn)!.tags ?? [];

    const updatedConfigs: MetricAlarmConfig[] = configs.map((config) => {
      const match = tags.find((tag) => tag.Key?.includes(config.tagKey));

      // update config.defaults with tag override values or use defaults
      config.defaults = match
        ? parseMetricAlarmOptions(match.Value ?? '', config.defaults)
        : config.defaults;

      return config;
    });

    //update the hostInfo map with the updated configs
    hostInfo.set(arn, {
      ...hostInfo,
      configs: updatedConfigs,
    });
  }

  private static buildPromExpressions(
    config: MetricAlarmConfig,
    hostID: string,
  ): string[] {
    // check if our config has a prometheus expression then build expressions for warning and critical thresholds if we do.
    const expressions: string[] | undefined = config.defaults
      .prometheusExpression
      ? ((() => {
        return [
          config.defaults.warningThreshold,
          config.defaults.criticalThreshold,
        ].map((severity) =>
          config.defaults.prometheusExpression
            ?.replace('/_STATISTIC/', `${config.defaults.statistic}`)
            .replace('/_THRESHOLD/', `${severity}`)
            .replace('/_HOST/', `${hostID}`),
        );
      })() as string[])
      : undefined;

    // if we don't have any expressions, return false
    if (!expressions) {
      this.log(
        'error',
        'buildPromExpressions',
        'No Prometheus expressions found',
        {
          config,
          hostID,
        },
      );
      throw new Error('No Prometheus expressions found');
    }

    this.log(
      'info',
      'buildPromExpressions',
      'Successfully built Prometheus expressions',
      expressions,
    );

    return expressions;
  }

  /**
   * Compare configs/AMP Rules in PromUpdateMap against NamespaceDetailsMap
   * Update NamespaceDetailsMap with new/updated rules, groups, and namespaces
   * @returns {{isUpdated: boolean; dynamoUpdates: PromUpdateMap}}
   * - Object indicating if updates were made and the updated NamespaceDetailsMap
   * // TODO: if we add or remove rules,
   */

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
      this.log(
        'error',
        'managePromDbAlarms',
        'Prometheus workspace ID is not set in environment variables.',
      );
      return false;
    }

    /**
     * Process each event pair to build the promUpdatesMap
     * We do NOT care about created events because they have no tags yet.
     * After created events, a follow-up tagged event will be sent if there are tags.
     */
    for (const pair of eventPairs) {
      const {eventParseResult} = pair;

      // Check for Destroyed events first and grab alarm info from DynamoDB if so.
      const destroyed = eventParseResult.isDestroyed ? this.dynamoDBFetch(eventParseResult.id) : void 0;

      // If destroyed update the promUpdatesMap with the destroyed info from DynamoDB
      if (destroyed) {
        promUpdatesMap.set(destroyedInfo.engine!, new Map());
        promUpdatesMap.get(destroyedInfo.engine!)!.set(destroyedInfo.arn!, {
          host: destroyedInfo.host,
          isDisabled: true, // Assume not disabled for destroyed events
        });
      }

      // TODO: check if we are not at the first index of the eventPairs array.
      // If we are not, we should check tags the PromUpdatesMap to see if our tag values match any existing entries.
      // If they do, we can continue to the next iteration of the loop without further processing.

      /**
       * For all other events, we check every secret for autoalarm tags and build the promHostInfoMap for all secrets with tags.
       */

      /**
       * 1. fetch a list of secrets with autolarm tags and then attempt to map secret values for host and engine
       */
      await this.fetchSecretTags(promHostInfoMap);
      await this.mapSecretValues(promHostInfoMap, promUpdatesMap);

      // clean up promHostInfoMap now that we moved the secrets to the prometheus updates map
      promHostInfoMap.clear();

      /**
       * 2. Remove any secrets that are disabled from the prometheus updates map we will skip these when building the rules file
       */
      const autoAlarmDisabledSecrets: string[] = [];

      Object.keys(promUpdatesMap).forEach((engine) => {
        const hostInfoMap = promUpdatesMap.get(engine)!;
        hostInfoMap.forEach((info, arn) => {
          if (info.isDisabled) {
            autoAlarmDisabledSecrets.push(arn);
            hostInfoMap.delete(arn);
          }
        });

        /**
         * 3. Build the PromUpdatesMap with configs and alert rules from the default/updated configs for each engine/host
         */

        // remove the engine from the promUpdatesMap if there are no hosts left after filtering out disabled secrets or,
        // they don't exist
        if (!hostInfoMap.size) promUpdatesMap.delete(engine);
      });

      // Log any hosts that are disabled and will not be included in the new ruleset for troubleshooting.
      if (autoAlarmDisabledSecrets.length) {
        this.log(
          'trace',
          'managePromDbAlarms',
          'Following Secrets are destroyed/disabled',
          {
            DisabledSecrets: autoAlarmDisabledSecrets,
          },
        );
      }

      // TODO: parse namespaceDetailsMap for each

      // If we successfully processed all secrets, log and return true
    }
  }
}
