import {Tag} from './index.mjs';

export type DynamoValidCategory = "cloudwatch" | "prometheus";
export type DynamoCategoryPartitionKey = `CATEGORY#${DynamoValidCategory}`;
export type DynamoResourceSortKey = `RESOURCE#${string}`;

/**
 * This is the structure of the entries in the AutoAlarm DynamoDB table.
 */
export interface DynamoRecordTemplate {
  PARTITIONKEY: DynamoCategoryPartitionKey;       // e.g. "CATEGORY#cloudwatch"
  SORTKEY: DynamoResourceSortKey;       // e.g. "RESOURCE#arn:aws:ec2:..."
  category: DynamoValidCategory;       // e.g. "cloudwatch or "prometheus"
  resource_arn: string;   // the ARN without the 'RESOURCE#' prefix
  alarms: string[];       // array of alarm names for the resource
  tags: Tag; // tags associated with the resource
}


export type DynamoUpdateCriteria = {
  category: DynamoValidCategory,
  arn: string,
  tableName: string
  alarms?: string[],
  tags?: Tag,
}
