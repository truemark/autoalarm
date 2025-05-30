import {SecretsManagerClient} from '@aws-sdk/client-secrets-manager'
import {
PROMETHEUS_MYSQL_CONFIGS,
PROMETHEUS_ORACLEDB_CONFIGS,
PROMETHEUS_POSTGRES_CONFIGS,
} from '../alarm-configs/index.mjs';
import { ServiceEventMap } from '../types/event-filtering-types.mjs';


export class SecManagerPrometheusModule {
  private client: SecretsManagerClient = new SecretsManagerClient({});
  private oracleDBConfigs = PROMETHEUS_ORACLEDB_CONFIGS;
  private mysqlConfigs = PROMETHEUS_MYSQL_CONFIGS;
  private postgresConfigs = PROMETHEUS_POSTGRES_CONFIGS;

  public static readonly SecretsManagerEventMap = {
    'aws.secretsmanager': {
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
  } as const as ServiceEventMap;



  private static rdsMappingFromSecretsManager(): string {
    /**
     * This is the host value from the secret.
     */
  }

  // TODO: Will need to create a function create prometheus querys with labels. Look at Prometheus.go in
  //  db collector for reference.
  private static buildPromQuery(): void{}

  //  TODO: We need to check if this is a create event becuase create events don't contain tag values
  //    even if a secretsmanager secret was created with a tag.
  //  TODO: If we untag a resource, we need to wait because SecretsManager sends two events and they may come
  //   out of order. need to pull tags again... a 30 second wait should be enough.
  // TODO: need logic to find and replace the 'period' value in the alarm config if a tag is provided to overwrite
  //  the default value.
  // TODO: We need logic to overwrite find and replace 'warningThreshold' and 'criticalThreshold' values if a tag is provided
  //  to overwrite the default value.
  static ManageRdsAlarms(
    isDestroyed: boolean,
    tags: {tagKey: string; tagValue?: string}[] | undefined,
    isARN: boolean,
    id: string,
  ): {updatedAlarms: string[]; UpdatedTags: Tag} {
    // first check if the id is a valid ARN. If not, convert it to an ARN
    const arn = !isARN
      ? `arn:aws:ssm:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:parameter/${id}`
      : id;

    // Map RDS instance/cluster ARN to the SSM parameter ARN
    const rdsMapping = this.rdsMappingFromSecretsManager();

    // build prom Queries
    const queries = this.createPromQuerysWithLables();


    //update prometheus rules
    //delete and update functionality - should be in prometheus-tools for a quick call.

    //compare queries against alarms from dynamoRecord.alarms then create updated array
    const updatedAlarms = dynamoRecord.alarms.filter((quereis) => {};

    // Update tags if needed
    const UpdatedTags = dynamoRecord.tags;
    if (tags) {
      tags.forEach((tag) => {
        if (tag.tagKey in UpdatedTags) {
          UpdatedTags[tag.tagKey] = tag.tagValue;
        } else {
          UpdatedTags[tag.tagKey] = tag.tagValue;
        }
      });
    }

    // return the updated alarms and tags
    return {
      updatedAlarms: updatedAlarms,
      UpdatedTags: UpdatedTags,
    };


  }

}
