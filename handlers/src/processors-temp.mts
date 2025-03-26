import {manageEC2} from './ec2-modules.mjs';
import {parseALBEventAndCreateAlarms} from './alb-modules.mjs';
import {parseCloudFrontEventAndCreateAlarms} from './cloudfront-modules.mjs';
import {parseOSEventAndCreateAlarms} from './opensearch-modules.mjs';
import {parseRDSEventAndCreateAlarms} from './rds-modules.mjs';
import {parseRDSClusterEventAndCreateAlarms} from './rds-cluster-modules.mjs';
import {parseR53ResolverEventAndCreateAlarms} from './route53-resolver-modules.mjs';
import {parseSQSEventAndCreateAlarms} from './sqs-modules.mjs';
import {parseSFNEventAndCreateAlarms} from './step-function-modules.mjs';
import {parseTGEventAndCreateAlarms} from './targetgroup-modules.mjs';
import {parseTransitGatewayEventAndCreateAlarms} from './transit-gateway-modules.mjs';
import {parseVpnEventAndCreateAlarms} from './vpn-modules.mjs';
import {ServiceProcessor} from './service-router.mjs';
import {SQSBatchItemFailure, SQSRecord} from 'aws-lambda';
import {SQSFailureResponse} from './types.mjs';

/**
 * EC2-specific processor implementation
 */
export class EC2Processor extends ServiceProcessor {
  constructor() {
    super('ec2');
  }

  /**
   * Check if this processor can handle the given record
   * Identifies EC2 records while excluding VPN and Transit Gateway records
   * @param record SQS record to check
   * @returns true if this is an EC2 record (and not a VPN or Transit Gateway record)
   */
  canProcess(record: SQSRecord): boolean {
    const searchResult = this.searchRecord(record, 'arn:aws:ec2:', '"');

    // Make sure it's an EC2 record but not a VPN or Transit Gateway
    if (searchResult) {
      if (searchResult.includes('vpn') || searchResult.includes('transit')) {
        this.log
          .trace()
          .str('class', 'EC2Processor')
          .str('function', 'canProcess')
          .str('messageId', record.messageId)
          .msg('Skipping VPN/Transit Gateway event');
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Process a batch of EC2 records
   * Optimized for Lambda's 10-record batch size, reducing API calls by batching EC2 operations
   * @param records Array of EC2 SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];
    const ec2InstanceMap: Record<string, SQSRecord>[] = [];

    // Transform records into the format expected by manageEC2
    for (const record of records) {
      try {
        const searchResult = this.searchRecord(record, 'arn:aws:ec2:', '"');

        if (searchResult) {
          // Extract instance ID
          const instanceId = searchResult.split('/').pop();

          if (instanceId) {
            this.log
              .trace()
              .str('class', 'EC2Processor')
              .str('function', 'process')
              .str('messageId', record.messageId)
              .str('instanceId', instanceId)
              .msg('Adding EC2 instance to batch');

            ec2InstanceMap.push({[searchResult]: record});
          }
        }
      } catch (error) {
        this.log
          .error()
          .str('class', 'EC2Processor')
          .str('function', 'process')
          .str('messageId', record.messageId)
          .err(error)
          .msg('Error preparing EC2 event for batch processing');

        batchItemFailures.push({
          itemIdentifier: record.messageId,
        });
        batchItemBodies.push(record);
      }
    }

    // Process the batch if we have EC2 instances
    if (ec2InstanceMap.length > 0) {
      this.log
        .info()
        .str('class', 'EC2Processor')
        .str('function', 'process')
        .num('instanceIDs', ec2InstanceMap.length)
        .msg('Processing batch of EC2 instances');

      try {
        const ec2FailedRecords = await manageEC2(ec2InstanceMap);

        if (ec2FailedRecords.length > 0) {
          this.log
            .error()
            .str('class', 'EC2Processor')
            .str('function', 'process')
            .num('failedItems', ec2FailedRecords.length)
            .msg('Batch item failures found in EC2 processing');

          ec2FailedRecords.forEach((record) => {
            const messageId = record[Object.keys(record)[0]].messageId;
            batchItemFailures.push({
              itemIdentifier: messageId,
            });
            batchItemBodies.push(record[Object.keys(record)[0]]);
          });
        }
      } catch (error) {
        this.log
          .error()
          .str('class', 'EC2Processor')
          .str('function', 'process')
          .err(error)
          .msg('Unhandled error during batch EC2 processing');

        // Add all records from the batch to failures since we can't determine which ones failed
        ec2InstanceMap.forEach((record) => {
          const instanceKey = Object.keys(record)[0];
          const sqsRecord = record[instanceKey];

          batchItemFailures.push({
            itemIdentifier: sqsRecord.messageId,
          });
          batchItemBodies.push(sqsRecord);
        });
      }
    }

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * ALB processor implementation
 */
export class ALBProcessor extends ServiceProcessor {
  constructor() {
    super('alb');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is an ALB record
   */
  canProcess(record: SQSRecord): boolean {
    return (
      !!this.searchRecord(record, 'arn:aws:elasticloadbalancing:', '"') &&
      !this.searchRecord(
        record,
        'arn:aws:elasticloadbalancing:targetgroup:',
        '"',
      )
    );
  }

  /**
   * Process a batch of ALB records
   * @param records Array of ALB SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseALBEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'ALBProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing ALB record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * CloudFront processor implementation
 */
export class CloudFrontProcessor extends ServiceProcessor {
  constructor() {
    super('cloudfront');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a CloudFront record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:cloudfront:', '"');
  }

  /**
   * Process a batch of CloudFront records
   * @param records Array of CloudFront SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseCloudFrontEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'CloudFrontProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing CloudFront record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * OpenSearch processor implementation
 */
export class OpenSearchProcessor extends ServiceProcessor {
  constructor() {
    super('opensearch');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is an OpenSearch record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:es:', '"');
  }

  /**
   * Process a batch of OpenSearch records
   * @param records Array of OpenSearch SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseOSEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'OpenSearchProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing OpenSearch record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * RDS processor implementation
 */
export class RDSProcessor extends ServiceProcessor {
  constructor() {
    super('rds');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is an RDS record (non-cluster)
   */
  canProcess(record: SQSRecord): boolean {
    const isRDS = !!this.searchRecord(record, 'arn:aws:rds:', '"');
    const isCluster = !!this.searchRecord(record, 'arn:aws:rds:cluster:', '"');
    return isRDS && !isCluster;
  }

  /**
   * Process a batch of RDS records
   * @param records Array of RDS SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseRDSEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'RDSProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing RDS record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * RDS Cluster processor implementation
 */
export class RDSClusterProcessor extends ServiceProcessor {
  constructor() {
    super('rds-cluster');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is an RDS Cluster record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:rds:cluster:', '"');
  }

  /**
   * Process a batch of RDS Cluster records
   * @param records Array of RDS Cluster SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseRDSClusterEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'RDSClusterProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing RDS Cluster record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * Route53 Resolver processor implementation
 */
export class Route53ResolverProcessor extends ServiceProcessor {
  constructor() {
    super('route53-resolver');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a Route53 Resolver record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:route53resolver:', '"');
  }

  /**
   * Process a batch of Route53 Resolver records
   * @param records Array of Route53 Resolver SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseR53ResolverEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'Route53ResolverProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing Route53 Resolver record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * SQS Queue processor implementation
 */
export class SQSProcessor extends ServiceProcessor {
  constructor() {
    super('sqs');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a SQS Queue record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:sqs:', '"');
  }

  /**
   * Process a batch of SQS Queue records
   * @param records Array of SQS Queue SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseSQSEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'SQSProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing SQS Queue record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * Step Function processor implementation
 */
export class StepFunctionProcessor extends ServiceProcessor {
  constructor() {
    super('step-function');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a Step Function record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:states:', '"');
  }

  /**
   * Process a batch of Step Function records
   * @param records Array of Step Function SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseSFNEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'StepFunctionProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing Step Function record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * Target Group processor implementation
 */
export class TargetGroupProcessor extends ServiceProcessor {
  constructor() {
    super('targetgroup');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a Target Group record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(
      record,
      'arn:aws:elasticloadbalancing:targetgroup:',
      '"',
    );
  }

  /**
   * Process a batch of Target Group records
   * @param records Array of Target Group SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseTGEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'TargetGroupProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing Target Group record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * Transit Gateway processor implementation
 */
export class TransitGatewayProcessor extends ServiceProcessor {
  constructor() {
    super('transit-gateway');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a Transit Gateway record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:ec2:transit-gateway:', '"');
  }

  /**
   * Process a batch of Transit Gateway records
   * @param records Array of Transit Gateway SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseTransitGatewayEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'TransitGatewayProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing Transit Gateway record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}

/**
 * VPN processor implementation
 */
export class VPNProcessor extends ServiceProcessor {
  constructor() {
    super('vpn');
  }

  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this is a VPN record
   */
  canProcess(record: SQSRecord): boolean {
    return !!this.searchRecord(record, 'arn:aws:ec2:vpn:', '"');
  }

  /**
   * Process a batch of VPN records
   * @param records Array of VPN SQS records to process
   * @returns SQS failure response containing any failed records
   */
  async process(records: SQSRecord[]): Promise<SQSFailureResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    const batchItemBodies: SQSRecord[] = [];

    await Promise.allSettled(
      records.map(async (record) => {
        try {
          await parseVpnEventAndCreateAlarms(record);
          return true;
        } catch (error) {
          this.log
            .error()
            .str('class', 'VPNProcessor')
            .str('function', 'process')
            .str('messageId', record.messageId)
            .err(error)
            .msg('Error processing VPN record');

          batchItemFailures.push({
            itemIdentifier: record.messageId,
          });
          batchItemBodies.push(record);
          return false;
        }
      }),
    );

    return {
      batchItemFailures,
      batchItemBodies,
    };
  }
}
