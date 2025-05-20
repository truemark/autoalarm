//TODO: May need to investigate concurrency issues with dynamoDB by adding a timestamp to the dynamoDB table Though we are using fifo queues so that should help
import {
  AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  GetItemCommandInput,
  GetItemCommandOutput,
  PutItemCommand,
  PutItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoCategoryPartitionKey,
  DynamoRecordTemplate,
  DynamoUpdateRecords,
  DynamoResourceSortKey,
  Tag, ExtantDynamoRecord, DynamoUpdateCriteria
} from '../../types/index.mjs';
import * as logging from '@nr1e/logging';
import {unmarshall} from '@aws-sdk/util-dynamodb';

// Initialize logging
const level = process.env.LOG_LEVEL || 'trace';
if (!logging.isLevel(level)) {
  throw new Error(`Invalid log level: ${level}`);
}

const log = logging.initialize({
  svc: 'AutoAlarm',
  name: 'dynamo-tools',
  level,
});


export class DynamoTools {
 private static client = new DynamoDBClient();

  /**
   * Dynamo Uses type indicators in queries. Here are the few we might use
   *  S = String
   *  N = Number
   *  BOOL = Boolean
   *  L = List (Array)
   *  M = Map (Object)
   *  SS = String Set
   *  NS = Number Set
   */

  private static async getDynamoRecord(
    category: string,
    arn: string,
    tableName: string,
  ): Promise<ExtantDynamoRecord> {
    const pKey = `CATEGORY#${category}`;
    const sKey = `RESOURCE#${arn}`;
    const tName = tableName;

    let res: GetItemCommandOutput | undefined;

    try {
      res = await this.client.send(
        new GetItemCommand({
          TableName: tName,
          Key: {
            PK: {S: pKey},
            SK: {S: sKey},
          },
        } as GetItemCommandInput),
      );

      // Check if the item exists. If not, create template for record to be created.
      if (!res.Item) {
        log
          .warn()
          .str('Function', 'dynamoGetRecord')
          .msg('No record found in DynamoDB. New records needs to be created');
        return undefined;
      }

      // Convert Dynamo DB Response to DynamoAlarmRecord for later use in updating/removing the record
      const record = unmarshall(res.Item);
      log
        .info()
        .str('Function', 'dynamoGetRecord')
        .str('TableName', tName)
        .obj('Record', res.Item)
        .msg('Record found in DynamoDB');

      return res;
    } catch (e) {
      log
        .error()
        .str('Function', 'dynamoGetRecord')
        .err(e)
        .msg('Error getting record from DynamoDB');
      throw e;
    }
  }

  /**
   * Function to create Dynamo Update template.
   * @param extantRecord informs the function if a record already exists in the DynamoDB table or if it does not. {@link getDynamoRecord}
   * @param recordCriteria is the criteria used to create the record template. {@link DynamoUpdateCriteria}
   *
   */
  private static createDynamoUpdateTemplate(
    extantRecord: ExtantDynamoRecord,
    recordCriteria: DynamoUpdateCriteria,
  ): DynamoRecordTemplate {
    return {
      CATEGORY: `CATEGORY#${category}` as DynamoCategoryPartitionKey,
      RESOURCE: `RESOURCE#${arn}` as DynamoResourceSortKey,
      category: category,
      resource_arn: arn,
      alarms: alarms,
      tags: tags,
    };
  }

  private static async deleteDynamoRecord()

  static async updateDynamoRecord(updateCriteria: DynamoUpdateCriteria) {
    await this.getDynamoRecord(updateCriteria.category, updateCriteria.arn, updateCriteria.tableName);
  }

}
