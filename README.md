# AutoAlarm Project README

## Overview

AutoAlarm is an AWS Lambda-based automation tool designed to dynamically manage CloudWatch alarms for EC2 instances based on instance states and specific tag values. The project uses AWS SDK for JavaScript v3, the AWS CDK for infrastructure deployment, and is integrated with AWS Lambda and CloudWatch for operational functionality.

## Architecture

The project consists of several key components:

- `MainHandler`: A TypeScript-based Lambda function that handles EC2 and CloudWatch operations.
- `AutoAlarmConstruct`: A CDK construct that sets up the necessary AWS resources and permissions for the Lambda function.
- `MainFunction`: A class extending `ExtendedNodejsFunction` to configure Lambda function specifics.
- `AutoAlarmStack`: The CDK stack that deploys the constructs and manages dependencies.

## Features

- **Dynamic Alarm Management**: Automatically creates, updates, and deletes CloudWatch alarms based on EC2 instance states and tag changes.
- **Customization Through Tags**: Uses tags to define alarm thresholds and conditions, allowing per-instance customization.
- **Scalable and Extendable**: Designed to handle multiple instances and can be extended to support other AWS resources.

## Usage

The system is event-driven, responding to EC2 state change notifications and tag modification events. To manage alarms, ensure your EC2 instances are tagged according to the supported schema defined below.

## Supported Tags

| Tag                                        | Description                                                                                              | Default Value        |
|--------------------------------------------|----------------------------------------------------------------------------------------------------------|----------------------|
| `autoalarm:disabled`                       | If set to "true", instance status check alarms will not be created for the resource. Default is "false". | `false`              |
| `autoalarm:cpu-percent-above-critical`     | Threshold for critical CPU utilization alarm. If not set, a default threshold of 99% is used.            | `99%`                |
| `autoalarm:cpu-percent-above-warning`      | Threshold for warning CPU utilization alarm. If not set, a default threshold of 97% is used.             | `97%`                |
| `autoalarm:cpu-percent-duration-time`      | Duration in seconds for CPU utilization to exceed the threshold before triggering the alarm.              | `60 seconds`         |
| `autoalarm:cpu-percent-duration-periods`   | Number of consecutive periods over which data is evaluated against the specified threshold.               | `5 periods`          |

### Default Alarm Behavior

If the `autoalarm:cpu-percent-above-critical` and `autoalarm:cpu-percent-above-warning` tags are not present, alarms will be created with default thresholds of 99% for critical alarms and 97% for warning alarms, respectively. These default settings ensure that basic monitoring is in place even if specific customizations are not specified. This default behavior helps to maintain a baseline of operational awareness and prompt response capability.
## EventBridge Rules

The project configures AWS EventBridge to route specific events to the AutoAlarm Lambda function. Below are the detailed rules created:

### Tag Rule

| Description                              | Value                                                                                                                                                                    |
|------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Event Source**                         | `aws.tag`                                                                                                                                                                |
| **Detail Type**                          | Tag Change on Resource                                                                                                                                                   |
| **Service**                              | EC2, ECS, RDS                                                                                                                                                            |
| **Resource Type**                        | Instance                                                                                                                                                                 |
| **Changed Tag Keys**                     | `autoalarm:disabled`, `autoalarm:cpu-percent-above-critical`, `autoalarm:cpu-percent-above-warning`, `autoalarm:cpu-percent-duration-time`, `autoalarm:cpu-percent-duration-periods` |

### EC2 State Change Rule

| Description                              | Value                                                                          |
|------------------------------------------|--------------------------------------------------------------------------------|
| **Event Source**                         | `aws.ec2`                                                                      |
| **Detail Type**                          | EC2 Instance State-change Notification                                         |
| **States**                               | `running`, `terminated`, `stopped`, `shutting-down`, `pending`                  |


## Limitations

- Currently supports only EC2 instances. Extension to other services like ECS or RDS would require modifications to the Lambda function and CDK setup.
- Tag-based configuration may not be suitable for all use cases. Customization options are limited to the supported tags.
- Some alarms are created by default even without tags, such as cpu utilization alarms and can only be modified with the use of tags. Otherwise, they will be created with default values.
