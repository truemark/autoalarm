# AutoAlarm Changelog

## v1.7.3
### Changes: 
- Implemented logic to throw warning instead of error in case of missing load balancer for target groups target group alarm creation module
- Updated README with note that Target Group alarms require a load balancer.
- 
### Fixed: 
- Fixed a bug that resulted in AutoAlarm throwing an error when load balancer is not associated with a target group leading to excessive delays through FIFO queue retries. 

## v1.7.2

## Changes
- Implemented producer-consumer pattern with SQS queue for realarm processing using SQS
- Implemented rate limiting and backoff for API calls to cloudwatch in ReAlarm processing
- Significantly reduced number of API calls to cloudwatch in ReAlarm processing
- Added proper throttling and error handling for ReAlarm processing. 

### Fixed: 
- Fixed bug that prevented ReAlarm from processing alarms in certain cases where total alarm volume resulted in AWS API throttling.

## v1.7.0

### Added:
- Enhanced ReAlarm functionality with per-alarm configuration using tags
- New tag-based ReAlarm scheduling system allowing customization of re-alarm intervals per alarm
- New EventBridge rule handler for managing ReAlarm schedules
- Support for dynamic ReAlarm schedule updates based on tag changes
- Tag-based configuration with `autoalarm:re-alarm-minutes` for custom schedules
- Tag-based configuration with `autoalarm:re-alarm-disabled` to disable ReAlarm for specific alarms

### Changed:
- ReAlarm is now enabled by default with a 120-minute schedule
- Improved ReAlarm error handling and retry logic
- Enhanced logging for better observability of ReAlarm operations
- Restructured ReAlarm configuration to be more flexible and maintainable
- Updated ReAlarm Lambda to support both scheduled and override-based executions
- Moved from global ReAlarm configuration to granular, tag-based configuration

### Removed:
- Removed global ReAlarm schedule configuration via CDK context
- Removed `useReAlarm` context variable (ReAlarm is now enabled by default)
- Removed `reAlarmSchedule` context variable (replaced with tag-based configuration)
- Removed `realarm:disabled` tag in favor of `autoalarm:re-alarm-disabled`

### Fixed:
- Fixed a bug that prevented retry logic from working correctly in ReAlarm due to improper package import. 


## v1.6.0

## Added:

-   Added a fifo queue to the alarm-tools module to ensure that alarms are created in the correct order.
-   Support added for CloudFront, Route53Resolver, TransitGateway, and VPN services.
-   Added ReAlarm Lambda which retriggers alarms in an alarm state for increased observability. This can be configured with tagging.

### Changed:

-   Updated the alarm-config.mts file to include the new services.
-   Updated the README to include the new services.
-   Updated the auto-alarm-construct.ts file to include the new services.
-   AutoAlarm Queue Alarms now treat missing data as missing, rather than breaching.
-   Tagging schema now allows for the autoalarm:target tag to be used to specify whether an EC2 instance creates Alarms in Cloudwatch or Amazon Managed Prometheus.
-   Added support for Amazon Managed Prometheus Service (AMP) and EC2 Prometheus Alarms for CPU, Memory and Disk Utilization.

### Fixed:

-   Fixed an issue where the alarm-tools module would not create alarms in the correct order when creating multiple alarms.
-   Fixed and issue where Tag change and state change events were not being processed correctly by the lambda function.

## v1.5.0

## Added

-   Added a new configuration file that centralizes all default alarm configurations for currently supported services in
    one place.
-   This file contains tag parsing logic used across all services modules used to create alarms.
-   This file also introduces a more robust tagging schema that simplifies tagging patterns across all services and alarm types.
-   This file allows alarms to be defined in a single location without the need to adjust code in each service module.
-   Support for OpenSearch has been added.

## Changed:

-   All services will now use the same tagging schema to enable non-default alarms and configure default and non-default
    alarms according to application and environment specific needs.
-   tags monitored by eventbridge rule listeners now no longer contain the service name. All tags now follow a convention
    of 'autoalarm:' followed by a short description of the metric. These are defined in the project README.

## Fixed:

## Removed:

-   Removed the old tagging schema.
-   Removed Various logging statements that were used for testing and no longer needed.




