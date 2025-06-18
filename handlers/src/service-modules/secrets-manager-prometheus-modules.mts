import {
  BatchGetSecretValueCommand,
  BatchGetSecretValueCommandInput,
  ListSecretsCommand,
  ListSecretsCommandInput,
  ListSecretsCommandOutput,
  SecretListEntry,
  SecretsManagerClient,
  Tag,
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
  NamespaceDetailsMap,
  PromHostInfoMap,
  PromUpdateMap,
  RecordMatchPairsArray,
  ServiceEventMap,
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
  private static log = new ModUtil(
    logging.getLogger('SecManagerPrometheusModule'),
  ).log;

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
        ? this.log(
            'info',
            'mapSecretValues',
            'Mapped secret values from Secrets Manager',
            {mappedSecrets: promUpdateMap.size},
          )
        : this.log(
            'error',
            'mapSecretValues',
            'No secrets found with autoalarm tags',
            {secretsRetrieved: allSecrets},
          );
    } catch (err) {
      this.log(
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
  private static async fetchSecretTags(
    promHostInfoMap: PromHostInfoMap,
    tagKeys: string[],
  ) {
    const allSecrets: SecretListEntry[] = [];
    let nextToken: string | undefined = undefined;

    // Loop through secrets to get all secrets and tags
    try {
      const input: ListSecretsCommandInput = {
        MaxResults: 100,
        NextToken: nextToken,
        Filters: [
          // FiltersListType
          {
            // Filter
            Key: 'tag-key',
            Values: [
              // FilterValuesStringList
              ...tagKeys,
            ],
          },
        ],
      };
      do {
        const response: ListSecretsCommandOutput = await this.client.send(
          new ListSecretsCommand(input),
        );

        allSecrets.push(...(response.SecretList ?? []));
        nextToken = response.NextToken;
      } while (nextToken);
    } catch (err) {
      this.log(
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
      this.log(
        'error',
        'fetchSecretTags',
        'Failed to fetch secrets from Secrets Manager',
        {cause: err},
      );
      throw err;
    }

    //reduce tags to only autoalarm tags and retype to TagV2[] since we know they exist.
    allSecrets.forEach((secret) => {
      const autoAlarmTags = ModUtil.parseTags(secret.Tags!);

      // If there are any autoalarm tags, add the secret to the promHostInfoMap
      autoAlarmTags?.length
        ? promHostInfoMap.set(secret.ARN!, {tags: autoAlarmTags})
        : void 0;
    });

    // Return isSuccess and the secretsWithTags if there are autoalarm secrets
    this.log(
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
        this.log('error', 'buildNamespaceDetailsMap', 'No configs found');
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
    this.log(
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
    this.log(
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
   * Compares NameSpaceDetailsMap against PromUpdateMap to find added/removed rules
   * @param namespaceDetailsMap - Current namespace configurations
   * @param promUpdateMap - Updated prometheus configurations from hosts
   * @param ruleGroupName - Optional: Name for the rule group (defaults to 'default')
   * @returns Object containing added rules, removed rules, and updated namespace map
   */
  private static compareNamespaceRules(
    namespaceDetailsMap: NamespaceDetailsMap,
    promUpdateMap: PromUpdateMap,
    ruleGroupName: string = 'default',
  ): CompareResult {
    const result: CompareResult = {
      addedRules: [],
      removedRules: [],
      updatedNamespaceDetailsMap: new Map(namespaceDetailsMap), // Clone the map
    };

    // Process each engine/namespace
    for (const [engine, hostInfoMap] of promUpdateMap) {
      // Collect all unique rules from all hosts for this engine
      const engineRules = collectEngineRules(hostInfoMap);

      // Get existing namespace config or create new one
      const existingConfig = namespaceDetailsMap.get(engine) || {groups: []};
      const existingRules = extractRulesFromGroups(existingConfig.groups);

      // Compare rules
      const {added, removed} = compareRuleSets(existingRules, engineRules);

      // Add to results if there are changes
      if (added.length > 0) {
        result.addedRules.push({
          namespace: engine,
          rules: added,
        });
      }

      if (removed.length > 0) {
        result.removedRules.push({
          namespace: engine,
          rules: removed,
        });
      }

      // Update the namespace details map with new rules
      if (engineRules.length > 0 || existingConfig.groups.length > 0) {
        result.updatedNamespaceDetailsMap.set(engine, {
          groups: [
            {
              name: ruleGroupName,
              rules: engineRules,
            },
          ],
        });
      } else {
        // Remove namespace if no rules exist
        result.updatedNamespaceDetailsMap.delete(engine);
      }
    }

    // Check for removed namespaces (in namespaceDetailsMap but not in promUpdateMap)
    for (const [namespace, config] of namespaceDetailsMap) {
      if (!promUpdateMap.has(namespace)) {
        const existingRules = extractRulesFromGroups(config.groups);
        if (existingRules.length > 0) {
          result.removedRules.push({
            namespace,
            rules: existingRules,
          });
          result.updatedNamespaceDetailsMap.delete(namespace);
        }
      }
    }

    return result;
  }

  /**
   * Checks an event par against any existing Prometheus updates
   *
   */
  private static checkEventAgainstPromUpdates(
    eventParseResult: EventParseResult,
    promUpdatesMap: PromUpdateMap,
  ): {shouldSkip: boolean} {
    // Check if the eventParseResult is already in the PromUpdatesMap
    for (const [engine] of promUpdatesMap.keys()) {
      if (!promUpdatesMap.get(engine)!.get(eventParseResult.id)) {

      }
    }


    // If the eventParseResult is already in the PromUpdatesMap, check tag values against the existing entries
  }

  /**
   * Public static method which is called in main-handler to manage DB prometheus alarms
   * @see {@link EventParseResult} for more details on the structure of this object.
   * @param eventPairs - contains an array of SQS records and their parsed event results.
   */
  //TODO: return object {isSuccess: boolean, dynamoUpdates: PromUpdateMap} to send to main handler for updating DynamoDB
  // so we don't have collisions with other service modules or in this one.
  // we should also grab all the dynamo entries in the main handler and pass them to this function to avoid multiple fetches.
  public static async managePromDbAlarms(
    eventPairs: RecordMatchPairsArray,
    dynamoTable,
  ): Promise<
    AlarmUpdateResult<{
      isSuccess: boolean;
      dynamoUpdates?: PromUpdateMap;
    }>
  > {
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
      return {
        isSuccess: false,
        res: 'Prometheus workspace ID is not set.',
      };
    }

    /**
     * Process each event pair to build the promUpdatesMap
     * We do NOT care about created events because they have no tags yet.
     * After created events, a follow-up tagged event will be sent if there are tags.
     */
    for (const pair of eventPairs) {
      const {eventParseResult} = pair;

      // Skip any created events as they have no tags so we can't check the PromUpdatesMap
      if (eventParseResult.isCreated) {
        this.log('trace', 'managePromDbAlarms', 'Skipping created event', {
          eventParseResult,
        });
        continue;
      }

      // Check if current index is not the first. If so, check against updates already made
      eventPairs.indexOf(pair) < 1 && !pair.eventParseResult.isDestroyed
        ? (() => {
            // Check if the eventParseResult is already in the promUpdatesMap
            const existingUpdate = this.checkEventAgainstPromUpdates(
              eventParseResult,
              promUpdatesMap,
            );
          })()
        : void 0;

      // Check for Destroyed events first and grab alarm info from DynamoDB if so.
      const destroyed = eventParseResult.isDestroyed
        ? this.dynamoDBFetch(eventParseResult.id)
        : void 0;

      // If destroyed update the promUpdatesMap with the destroyed info from DynamoDB
      if (destroyed && destroyed.alarmsFound) {
        // Check to see if our map has been set. If not, set it.
        promUpdatesMap.get(destroyed.engine!)
          ? promUpdatesMap.set(destroyed.engine!, new Map())
          : void 0;

        // Add the destroyed info to the promUpdatesMap
        promUpdatesMap.get(destroyed.engine!)!.set(destroyed.arn!, {
          host: destroyed.host,
          isDisabled: true, // Assume not disabled for destroyed events
        });
      }

      /**
       * get all configs and parse out the tag keys
       * @returns Array<string> of tag keys for the configs, e.g. ['autoalarm:enabled', 'autoalarm:cpu', 'autoalarm:4xx']
       */
      const tagKeys = [
        ...ModUtil.getTagKeysForConfig([
          this.oracleDBConfigs,
          this.mysqlConfigs,
          this.postgresConfigs,
        ]),
      ];

      // TODO: check if we are not at the first index of the eventPairs array.
      // If we are not, we should check tags the PromUpdatesMap to see if our tag values match any existing entries.
      // If they do, we can continue to the next iteration of the loop without further processing.

      /**
       * For all other events, we check every secret for autoalarm tags and build the promHostInfoMap for all secrets with tags.
       */

      /**
       * 1. fetch a list of secrets with autolarm tags and then attempt to map secret values for host and engine
       */
      await this.fetchSecretTags(promHostInfoMap, tagKeys);
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
