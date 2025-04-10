/**
 * @fileoverview Service Module Barrel File for AutoAlarm even processing
 *
 * This barrel file centralizes exports from various service-specific modules,
 * providing a single import point for Lambda handlers to access service specific event processing
 *
 * ---
 *
 * ## Barrel File Purpose
 *
 * This file consolidates multiple service module functions/methods into organized exports to:
 * - Reduce import clutter in Lambda handlers
 * - Provide consistent naming patterns
 * - Centralize service module registration
 * - Enable both granular and bulk imports
 *
 * ---
 *
 * ## How to Import in lambda handlers:
 *
 * ```typescript
 * // Import everything
 * import * as AlarmModules from '#service-modules';
 *
 * // Import specific groups
 * import { EC2, ServiceModules } from '#service-modules';
 *
 * // Import individual functions
 * import { parseALBEventAndCreateAlarms, parseRDSEventAndCreateAlarms } from '#service-modules';
 * ```
 *
 * ## Adding New Service Modules
 *
 * When adding support for a new AWS service:
 * 1. Create the service module in the appropriate directory
 * 2. Import the module's main handler function(s) at the top of this file
 * 3. Add the function to the individual exports list
 * 4. Add the function to the ServiceModules object (alphabetically)
 * 5. If needed, create a new grouped export for service-specific utilities
 *
 * ---
 * @module service-modules
 * @see autoalarm/handlers/src/main-handler.mts for implementation
 */
import {
  manageInactiveInstanceAlarms,
  manageActiveEC2InstanceAlarms,
  getEC2IdAndState,
  fetchInstanceTags,
  liveStates,
  deadStates,
} from '#service-modules/ec2-modules.mjs';
import {parseALBEventAndCreateAlarms} from '#service-modules/alb-modules.mjs';
import {parseTGEventAndCreateAlarms} from '#service-modules/targetgroup-modules.mjs';
import {parseSQSEventAndCreateAlarms} from '#service-modules/sqs-modules.mjs';
import {parseOSEventAndCreateAlarms} from '#service-modules/opensearch-modules.mjs';
import {parseVpnEventAndCreateAlarms} from '#service-modules/vpn-modules.mjs';
import {parseR53ResolverEventAndCreateAlarms} from '#service-modules/route53-resolver-modules.mjs';
import {parseTransitGatewayEventAndCreateAlarms} from '#service-modules/transit-gateway-modules.mjs';
import {parseCloudFrontEventAndCreateAlarms} from '#service-modules/cloudfront-modules.mjs';
import {parseRDSEventAndCreateAlarms} from '#service-modules/rds-modules.mjs';
import {parseRDSClusterEventAndCreateAlarms} from '#service-modules/rds-cluster-modules.mjs';
import {parseSFNEventAndCreateAlarms} from '#service-modules/step-function-modules.mjs';

/**
 * Service module functions/methods for processing AWS service events and creating alarms.
 *
 * These methods serve as entrypoints from the main handler into various service-specific modules.
 * Each function processes events from a specific AWS service and handles service event processing.
 *
 * ---
 * @example
 * ```typescript
 * // Import the entire module
 * import { ServiceModules } from '#service-modules';
 *
 * // Call functions as needed
 * ServiceModules.parseCloudFrontEventAndCreateAlarms(event);
 * ServiceModules.parseOSEventAndCreateAlarms(event);
 * ServiceModules.parseRDSEventAndCreateAlarms(event);
 * ```
 */
export const ServiceModules = {
  EC2: {
    manageInactiveInstanceAlarms,
    manageActiveEC2InstanceAlarms,
    getEC2IdAndState,
    fetchInstanceTags,
    liveStates,
    deadStates
  },
  parseALBEventAndCreateAlarms,
  parseCloudFrontEventAndCreateAlarms,
  parseOSEventAndCreateAlarms,
  parseRDSEventAndCreateAlarms,
  parseRDSClusterEventAndCreateAlarms,
  parseR53ResolverEventAndCreateAlarms,
  parseSQSEventAndCreateAlarms,
  parseSFNEventAndCreateAlarms,
  parseTGEventAndCreateAlarms,
  parseTransitGatewayEventAndCreateAlarms,
  parseVpnEventAndCreateAlarms
};
