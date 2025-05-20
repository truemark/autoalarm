import {Service, Tag} from './index.mjs';
import {GetItemCommandOutput} from '@aws-sdk/client-dynamodb';

export type DynamoValidCategory = "cloudwatch" | "prometheus";
export type DynamoCategoryPartitionKey = `CATEGORY#${DynamoValidCategory}`;
export type DynamoResourceSortKey = `RESOURCE#${string}`;

/**
 * This is the structure of the entries in the AutoAlarm DynamoDB table.
 */
export interface DynamoRecordTemplate {
  CATEGORY: DynamoCategoryPartitionKey;       // e.g. "CATEGORY#cloudwatch"
  RESOURCE: DynamoResourceSortKey;       // e.g. "RESOURCE#arn:aws:ec2:..."
  category: string;       // e.g. "cloudwatch or "prometheus"
  resource_arn: string;   // the ARN without the 'RESOURCE#' prefix
  alarms: string[];       // array of alarm names for the resource
  tags: Tag[]; // tags associated with the resource
}



/**
 * Used to inform how a record template should be created for updating the DynamoDB table (i.e. if a current record exists or not)
 */
export type ExtantDynamoRecord =  GetItemCommandOutput | undefined


export type DynamoUpdateCriteria = {
  category: DynamoValidCategory,
  arn: string,
  tableName: string
  alarms: string[],
  tags: Tag[],
}
