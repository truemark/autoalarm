import {SecretsManagerClient} from '@aws-sdk/client-secrets-manager'
import {
PROMETHEUS_MYSQL_CONFIGS,
PROMETHEUS_ORACLEDB_CONFIGS,
PROMETHEUS_POSTGRES_CONFIGS,
} from '../alarm-configs/index.mjs';
import { ServiceEventMap } from '../types/index.mjs';
import * as logging from '@nr1e/logging';


export class SecManagerPrometheusModule {
  private client: SecretsManagerClient = new SecretsManagerClient({});
  private oracleDBConfigs = PROMETHEUS_ORACLEDB_CONFIGS;
  private mysqlConfigs = PROMETHEUS_MYSQL_CONFIGS;
  private postgresConfigs = PROMETHEUS_POSTGRES_CONFIGS;
  private static log = logging.getLogger('SecManagerPrometheusModule');

  public static readonly SecretsManagerEventMap: ServiceEventMap = {
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
  } as const;




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
  static async manageDbAlarms(
    isDestroyed: boolean,
    tags: {tagKey: string; tagValue?: string}[] | undefined,
    isARN: boolean,
    id: string,
  ): Promise<boolean> {
    try {

      // Map RDS instance/cluster ARN to the SSM parameter ARN
      const rdsMapping = this.rdsMappingFromSecretsManager();

      // build prom Queries
      const queries = this.createPromQuerysWithLables();


      //update prometheus rules
      //delete and update functionality - should be in prometheus-tools for a quick call.

    } catch (error) {
      this.log
        .error()
        .str('Function', 'manageDbAlarms')
        .unknown('error', error)
        .msg('Error managing DB alarms');
      return false;

    }

    // Return true if successful.
    return true


  }

}
