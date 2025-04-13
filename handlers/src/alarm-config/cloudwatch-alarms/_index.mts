/**
 * @fileoverview Alarm Configuration Barrel File for AutoAlarm
 *
 * This barrel file centralizes alarm configurations from various AWS services,
 * providing a single unified access point for the AutoAlarm system to retrieve
 * service-specific CloudWatch alarm definitions.
 *
 * ---
 *
 * ## Barrel File Purpose
 *
 * This file consolidates multiple service-specific CloudWatch alarm configurations into organized exports to:
 * - Provide a single source of truth for all alarm configurations
 * - Enable consistent alarm creation across different AWS services
 * - Simplify configuration management and versioning
 * - Support both service-specific and comprehensive alarm access patterns
 * - Facilitate bulk operations across all alarm configurations
 *
 * ---
 *
 * ## Type Safety
 *
 * The configurations follow the {@link MetricAlarmConfig} interface that ensures:
 * - Proper CloudWatch alarm properties are defined
 * - Statistic values match CloudWatch's accepted values
 * - Comparison operators are type-checked against AWS SDK enums
 * - Missing data treatments conform to CloudWatch's requirements
 *
 * ---
 *
 * ## How to Import in handlers:
 *
 * ```typescript
 * // Import all alarm configurations as a single object
 * import {AlarmConfigs} from '#alarm-config/_index.mts';
 *
 * // Access specific service configurations by service key
 * const sqsConfigs = AlarmConfigs.SQS;
 * const ec2Configs = AlarmConfigs.EC2;
 * ```
 *
 * ## Adding New Alarm Configurations
 *
 * When adding support for a new AWS service:
 * 1. Create a new alarm configuration file using the template generator:
 *    ```bash
 *    pnpm create-cw-config [SERVICE_NAME] [TEAM_NAME]
 *    ```
 * 2. Define the service-specific alarm configurations in that file following the template pattern
 * 3. Import the configurations at the top of this file (maintain alphabetical order)
 * 4. Add the imported configurations to the AlarmConfigs object (alphabetically)
 *
 * ---
 *
 * ## Service Coverage
 *
 * Current AWS services with alarm configurations:
 * - Application Load Balancer (ALB)
 * - CloudFront
 * - EC2
 * - OpenSearch
 * - RDS (both instance and cluster levels)
 * - Route53 Resolver
 * - SQS
 * - Step Functions
 * - Target Groups
 * - Transit Gateway
 * - VPN Connections
 *
 * @module alarm-config
 * @see {@link MetricAlarmConfig} For the configuration interface structure
 * @see {@link MetricAlarmConfigs} For the exported object type definition
 * @see autoalarm/handlers/src/service-modules for implementation with event handlers
 */
import {_ALB} from '#alarms/alb-configs.mjs';
import {_CLOUDFRONT} from '#alarms/cloudfront-configs.mjs';
import {_EC2} from '#alarms/ec2-configs.mjs';
import {_OPENSEARCH} from '#alarms/opensearch-configs.mjs';
import {_RDS_CLUSTER} from '#alarms/rds-cluster-configs.mjs';
import {_RDS} from '#alarms/rds-configs.mjs';
import {_ROUTE53_RESOLVER} from '#alarms/route53-resolver-configs.mjs';
import {_SQS} from '#alarms/sqs-configs.mjs';
import {_STEP_FUNCTION} from '#alarms/step-function-configs.mjs';
import {_TARGET_GROUP} from '#alarms/target-group-configs.mjs';
import {_TRANSIT_GATEWAY} from '#alarms/transit-gateway-configs.mjs';
import {_VPN} from '#alarms/vpn-configs.mjs';

export abstract class AlarmConfigs {
  // Private storage of configurations
  private static readonly _configs = {
    ALB: [..._ALB],
    CLOUDFRONT: [..._CLOUDFRONT],
    EC2: [..._EC2],
    OPENSEARCH: [..._OPENSEARCH],
    RDS: [..._RDS],
    RDS_CLUSTER: [..._RDS_CLUSTER],
    ROUTE53_RESOLVER: [..._ROUTE53_RESOLVER],
    SQS: [..._SQS],
    STEP_FUNCTION: [..._STEP_FUNCTION],
    TARGET_GROUP: [..._TARGET_GROUP],
    TRANSIT_GATEWAY: [..._TRANSIT_GATEWAY],
    VPN: [..._VPN],
  } as const;

  // Public access methods
  static get ALB() {
    return this._configs.ALB;
  }
  static get CLOUDFRONT() {
    return this._configs.CLOUDFRONT;
  }
  static get EC2() {
    return this._configs.EC2;
  }
  static get OPENSEARCH() {
    return this._configs.OPENSEARCH;
  }
  static get RDS() {
    return this._configs.RDS;
  }
  static get RDS_CLUSTER() {
    return this._configs.RDS_CLUSTER;
  }
  static get ROUTE53_RESOLVER() {
    return this._configs.ROUTE53_RESOLVER;
  }
  static get SQS() {
    return this._configs.SQS;
  }
  static get STEP_FUNCTION() {
    return this._configs.STEP_FUNCTION;
  }
  static get TARGET_GROUP() {
    return this._configs.TARGET_GROUP;
  }
  static get TRANSIT_GATEWAY() {
    return this._configs.TRANSIT_GATEWAY;
  }
  static get VPN() {
    return this._configs.VPN;
  }
}
