//TODO: May need to investigate concurrency issues with dynamoDB by adding a timestamp to the dynamoDB table Though we are using fifo queues so that should help
import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoValidCategory,
  DynamoRecordTemplate,
  DynamoUpdateCriteria,
  DynamoCategoryPartitionKey,
  DynamoResourceSortKey,
} from '../../types/index.mjs';
import * as logging from '@nr1e/logging';
import {marshall, unmarshall} from '@aws-sdk/util-dynamodb';

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

  /**
   * Gets current alarms and tags or builds a record template for a specific
   * resource in DynamoDB if the record does not exist.
   */
  static async getDynamoRecord(
    category: DynamoValidCategory,
    arn: string,
    tableName: string,
  ): Promise<DynamoRecordTemplate> {
    const PK = `CATEGORY#${category}`;
    const SK = `RESOURCE#${arn}`;

    try {
      const res = await this.client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            PK: {S: PK},
            SK: {S: SK},
          },
        }),
      );

      if (!res.Item) {
        log
          .warn()
          .str('Function', 'dynamoGetRecord')
          .msg('No record found in DynamoDB. New record needs to be created');
      }

      const record = res.Item
        ? (unmarshall(res.Item) as DynamoRecordTemplate)
        : undefined;

      // Build record template for either existing or new record
      return this.createDynamoUpdateTemplate(category, arn, record);
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
   * Returns a normalized DynamoRecordTemplate suitable for updates/puts.
   * If a record already exists in DynamoDB, merges data with normalized keys.
   * Otherwise, builds a default record template.
   */
  private static createDynamoUpdateTemplate(
    category: DynamoValidCategory,
    arn: string,
    extantRecord?: Partial<DynamoRecordTemplate>,
  ): DynamoRecordTemplate {
    // Use values from existing, or fill blanks
    return {
      PARTITIONKEY: `CATEGORY#${category as DynamoValidCategory}`,
      SORTKEY: `RESOURCE#${arn}`,
      category: category,
      resource_arn: arn,
      alarms: extantRecord?.alarms || [],
      tags: extantRecord?.tags || {},
    };
  }

  private static async deleteDynamoRecord(
    category: DynamoValidCategory,
    arn: string,
    tableName: string,
  ) {
    try {
      const PK = `CATEGORY#${category}`;
      const SK = `RESOURCE#${arn}`;
      await this.client.send(
        new DeleteItemCommand({
          TableName: tableName,
          Key: {
            PK: {S: PK},
            SK: {S: SK},
          },
        }),
      );
    } catch (e) {
      log
        .error()
        .str('Function', 'dynamoDeleteRecord')
        .err(e)
        .msg('Error deleting record from DynamoDB');
      throw e;
    }

    log
      .info()
      .str('Function', 'dynamoDeleteRecord')
      .str('PK', `CATEGORY#${category}`)
      .str('SK', `RESOURCE#${arn}`)
      .msg('Record deleted from DynamoDB');
  }

  private static async putDynamoRecord(
    pKey: DynamoCategoryPartitionKey,
    sKey: DynamoResourceSortKey,
    updateCriteria: DynamoUpdateCriteria,
  ) {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: updateCriteria.tableName,
          Item: marshall({
            PK: pKey,
            SK: sKey,
            category: updateCriteria.category,
            resource_arn: updateCriteria.arn,
            alarms: updateCriteria.alarms,
            tags: updateCriteria.tags,
          }),
        }),
      );
    } catch (e) {
      log
        .error()
        .str('Function', 'dynamoPutRecord')
        .obj('updateCriteria', updateCriteria)
        .err(e)
        .msg('Error putting record in DynamoDB');
      throw e;
    }
  }

  static async updateDynamoRecord(
    recordToUpdate: DynamoRecordTemplate,
    updateCriteria: DynamoUpdateCriteria,
  ) {
    // Delete Original Record
    await this.deleteDynamoRecord(
      recordToUpdate.category,
      updateCriteria.arn,
      updateCriteria.tableName,
    );

    // If a resource has been deleted or autoalarm is disabled, no need to update. Early return
    if (!updateCriteria.alarms && !updateCriteria.tags) return;

    // Rebuild the record with updated alarms and tags
    await this.putDynamoRecord(
      recordToUpdate.PARTITIONKEY as DynamoCategoryPartitionKey,
      recordToUpdate.SORTKEY as DynamoResourceSortKey,
      updateCriteria,
    );

    log
      .info()
      .str('Function', 'dynamoUpdateRecord')
      .obj('recordToUpdate', recordToUpdate)
      .obj('updateCriteria', updateCriteria)
      .msg('Record updated in DynamoDB');
  }
}
