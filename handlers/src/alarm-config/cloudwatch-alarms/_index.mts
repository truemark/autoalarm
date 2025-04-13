/**
 * @fileoverview Alarm Configuration Barrel File for AutoAlarm
 *
 * This barrel file centralizes alarm configurations from various AWS services,
 * providing a single access point for the AutoAlarm system to retrieve service-specific
 * alarm definitions.
 *
 * ---
 *
 * ## Barrel File Purpose
 *
 * This file consolidates multiple service-specific alarm configurations into organized exports to:
 * - Provide a single source of truth for all alarm configurations
 * - Enable consistent alarm creation across different AWS services
 * - Simplify configuration management and updates
 * - Allow both service-specific and comprehensive alarm access
 *
 * ---
 *
 * ## How to Import in handlers:
 *
 * ```typescript
 * // Import all alarm configurations
 * import {AlarmConfigs} from '#alarm-config/_index.mts';
 *
 * // Access specific service configurations
 * const configs = AlarmConfigs.SQS;
 * ```
 *
 * ## Adding New Alarm Configurations
 *
 * When adding support for a new AWS service:
 * 1. Create a new alarm configuration file using the template generator
 *    (Run `pnpm create-cw-config [SERVICE_NAME] [TEAM_NAME]`)
 * 2. Define the service-specific alarm configurations in that file
 * 3. Import the configurations at the top of this file
 * 4. Add the imported configurations to the AlarmConfigs object (alphabetically)
 * 5. Export the configurations individually
 *
 * ---
 * @module alarm-config
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
import {MetricAlarmConfigs} from '#types/alarm-config-types.mjs';

// Create a single object to export all alarm configurations
export const AlarmConfigs: MetricAlarmConfigs = {
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
