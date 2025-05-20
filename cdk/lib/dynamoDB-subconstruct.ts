/**
 * Represents a hierarchical alarm organization for AWS resources by category and service,
 * designed to map directly to a DynamoDB table schema using packed arrays for alarms.
 *
 * ## Structure (designed for efficient querying in DynamoDB with packed arrays):
 *
 * The key DynamoDB schema components:
 * - Partition Key (PK): `CATEGORY#{category}` (e.g. "CATEGORY#cloudwatch")
 * - Sort Key (SK):      `RESOURCE#{resourceArn}` (e.g. "RESOURCE#arn:aws:ec2:...")
 * - Attributes:
 *    - category: string            // e.g. 'cloudwatch' or 'prometheus'
 *    - resource_arn: string        // The AWS resource ARN
 *    - alarms: string[]            // Array of alarm names for the resource
 *
 * This is conceptually equivalent to the following nested structure:
 *
 * ```
 * {
 *   [category: string]: {
 *         resourceARNs: {
 *           [resourceArn: string]: {
 *             alarms: string[]
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * ## Example:
 *
 * ```json
 * {
 *   "PK": "CATEGORY#cloudwatch",
 *   "SK": "RESOURCE#arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0",
 *   "category": "cloudwatch",
 *   "resource_arn": "arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0",
 *   "alarms": [
 *     "example-alarm-name1",
 *     "example-alarm-name2",
 *     "example-alarm-name3"
 *   ],
 *   "tags": {
 *     "autoalarm:enabled": "true",
 *     "autoalarm:cpu": "80/90"
 *   }
 * }
 * ```
 *
 * ## DynamoDB Query Patterns
 * - Query all resources for a category: PK=`CATEGORY#cloudwatch`, SK begins_with `RESOURCE#`
 *   (then filter attribute "ARN" by the desired service)
 * - Get all alarms for a resource: Query by PK=`CATEGORY#cloudwatch`, SK=`RESOURCE#{resourceArn}` and read `.alarms`
 *
 * @remarks
 * - Packing alarms into an array makes lookups and batch updates for a single resource efficient, but does not support
 *   direct querying on alarm names alone.
 * - To add or remove an alarm, update the alarms array for the resource.
 */
import {Construct} from 'constructs';
import {ExtendedTableV2} from 'truemark-cdk-lib/aws-dynamodb';
import {ExtendedNodejsFunction} from 'truemark-cdk-lib/aws-lambda';
import {AttributeType} from 'aws-cdk-lib/aws-dynamodb';

export class AutoAlarmDynamoTable extends Construct {
  public readonly table: ExtendedTableV2;


  constructor(
    scope: Construct,
    id: string,
    mainFunctionLambda: ExtendedNodejsFunction,
  ) {
    super(scope, id);

    this.table = new ExtendedTableV2(this, 'AlarmTrackingTable', {
      partitionKey: {name: 'CATEGORY', type: AttributeType.STRING},
      sortKey: {name: 'RESOURCE', type: AttributeType.STRING},
      tableName: id,
    });

    // Grant the Lambda function permissions to read and write to the DynamoDB table
    this.table.grantReadWriteData(mainFunctionLambda);
  }
}
