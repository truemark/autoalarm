import {
  SecretsManagerClient,
  DescribeSecretCommand,
  ListSecretsCommandInput,
  SecretListEntry,
  ListSecretsCommand,
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
  Tag,
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
   * Helper function to hash arn/id to more securely store and later retreive in dynamoDB.
   */
  private static hashArn(arn: string): string {
    // This function is a placeholder for the actual hashing logic.
    // It should return a hashed version of the ARN.
    // For now, we will return the ARN as is.
    return arn; // Replace with actual hashing logic
  }

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
   * Fetch all ARNs and corresponding autoalarm tags.r
   * @private
   */
  private static async fetchTags(client: SecretsManagerClient): Promise<
    AlarmUpdateResult<{
      autoalarmSecrets: Record<string, TagsObject>[];
    }>
  > {
    //set next token for later use to grab all secrets
    let nextToken: string | undefined = undefined;

    // Initialize an array to hold all secrets
    const allSecrets: SecretListEntry[] = [];

    // Fetch all secrets in a loop until there are no more pages
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

    // Using type assertion here because we already sufficiently type guard above in autoalarmSecrets filter
    const secretsWithTags = autoalarmSecrets.map((secret) => ({
      arn: secret.ARN,
      tags: secret.Tags,
    })) as unknown as Record<string, TagsObject>[];

    // return isSuccess if there are no autoalarm secrets so we have a logging trail
    if (secretsWithTags.length === 0) {
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
  private static async handleDestroyedAndDisabled<T extends boolean>(
    prometheusWorkspaceId: string,
    engine: string,
    hostID: string,
  ): Promise<AlarmUpdateResult> {
    // some service events may not need to action this event type. Ideally these would be removed from the event map

    // Try to handle the destroyed event by deleting all Prometheus rules for the host
    try {
      await deletePromRulesForService(prometheusWorkspaceId, engine, [
        hostID,
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
          'Secrets Manager sends follow up events for tags after CreateSecret event. Event handled.',
        );
      return true;
    }

    // Handle Destroyed events (delete alarms, fetch info first)
    if (eventParseResult.isDestroyed) {
      const destroyedInfo = await this.dynamoDBFetch(eventParseResult.id);

      // Early exit on failed fetch
      if (!destroyedInfo?.isSuccess) {
        this.log
          .error()
          .str('Function', 'manageDbAlarms')
          .unknown('DynamoDBFetchError', destroyedInfo?.res)
          .msg('Failed to fetch DynamoDB data for destroyed secret. Cannot proceed.');
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
          destroyedInfo.data.host!, destroyedInfo.data.engine!);

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
      // All work for destroyed events is done, early exit
      return true;
    }



    // Create and destroyed events have both been handled, only events here are UntagResource and TagResource.



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
