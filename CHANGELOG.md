# AutoAlarm Changelog

## v1.5.0

## Additions: 

### alarm-config.mts
- Added a new configuration file that centralizes all default alarm configurations for currently supported services in 
one place. 
- This file contains tag parsing logic that is utilized across all services modules used to create alarms. 
- This file also introduces a more robust tagging schema that simplifies tagging patterns across all services and alarm types. 
- This file allows alarms to be defined in a single location without the need to adjust code in each service module.

### prometheus-tools.mts
- Added a new module that contains functions for interacting with Prometheus. These tools will be used to manage 
prometheus alarms. These will later be integrated into ec2-modules. Still under development. 

## Major Revisions: 

### alarm-tools.mts
- Refactored functions to create static threshold and anomaly alarms which now allow for multiple dimensions. 
- Created helper functions for both anomaly and static alarms to offload alarm objects sent to cloudwatch api.
- Several other helper functions were added to delete alarms, validate period durations for compatability with the 
cloudwatch api, build alarm names. 
- Old alarm creation logic has been removed. 
- Period duration validation has been consolidated into a helper function to reduce code duplication.

### alb-modules.mts, ec2-modules.mts, opensearch-modules.mts, sqs-modules.mts, and targetgroup-modules.mts
- All modules have been rebuilt to use the parsing logic from the alarm-config.mts file and the new alarm tools. 

### auto-alarm-construct.ts
- tags monitored by eventbridge rule listeners now no longer contain the service name. All tags now follow a convention
of 'autoalarm:' followed by a short description of the metric. These are defined in the project README.

## Changes in implementation:
- While the autoalarm:enabled tag is still used to enable default alarms, the new tagging schema allows for more 
consistent use across all services and alarm types. All services will now use the same tagging schema to enable 
non-default alarms and configure default and non-default alarms according to application and environment specific needs.
- Definitions and instructions can be found in the project README.




