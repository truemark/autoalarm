import {SecretsManagerClient} from '@aws-sdk/client-secrets-manager'
import {DynamoRecordTemplate, Tag} from '../types/index.mjs';


export class PrometheusRDSManager {
  private secretsManagerClient: SecretsManagerClient;

  constructor() {
    this.secretsManagerClient = new SecretsManagerClient({});
  }



  /**
   * Function to handle the mapping of the secret ARN to the RDS instance/cluster
   * @param tagKey - The tag key.
   * @param arn - The ARN of the resource.
   */
  private static rdsMappingFromSecretsManager(): string {
    /**
     * This is the host value from the secret.
     */
  }

  // TODO: Will need to create a function create prometheus querys with labels. Look at Prometheus.go in
  //  db collector for reference.
  private static createPromQuerysWithLables(): void{}

  //  TODO: We need to check if this is a create event becuase create events don't contain tag values
  //    even if a secretsmanager secret was created with a tag.
  //  TODO: If we untag a resource, we need to wait because SecretsManager sends two events and they may come
  //   out of order. need to pull tags again... a 30 second wait should be enough. Dynamo will take care of
  //   double updates.
  static ManageRdsAlarms(
    dynamoRecord: DynamoRecordTemplate,
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
