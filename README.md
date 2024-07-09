# AutoAlarm Project README

## Overview

AutoAlarm is an AWS Lambda-based automation tool designed to dynamically manage CloudWatch alarms and Prometheus rules for EC2 instances based on instance states and specific tag values. The project uses AWS SDK for JavaScript v3, the AWS CDK for infrastructure deployment, and is integrated with AWS Lambda, CloudWatch, and Prometheus for operational functionality.

## Architecture

The project consists of several key components:

- `MainHandler`: A TypeScript-based Lambda function that handles EC2, CloudWatch, and Prometheus operations.
- `AutoAlarmConstruct`: A CDK construct that sets up the necessary AWS resources and permissions for the Lambda function.
- `MainFunction`: A class extending `ExtendedNodejsFunction` to configure Lambda function specifics.
- `AutoAlarmStack`: The CDK stack that deploys the constructs and manages dependencies.

## Features

- **Dynamic Alarm Management**: Automatically creates, updates, and deletes CloudWatch alarms and Prometheus rules based on EC2 instance states and tag changes.
- **Customization Through Tags**: Uses tags to define alarm thresholds and conditions, allowing per-instance customization.
- **Scalable and Extendable**: Designed to handle multiple instances and can be extended to support other AWS resources.

## Usage

The system is event-driven, responding to EC2 state change notifications and tag modification events. To manage alarms and Prometheus rules, ensure your EC2 instances are tagged according to the supported schema defined below.

## Supported Tags

| Tag                                      | Description                                                                                              | Default Value |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |---------------|
| `autoalarm:disabled`                     | If set to "true", instance status check alarms will not be created for the resource. Default is "false". | `false`       |
| `autoalarm:cpu-percent-above-critical`   | Threshold for critical CPU utilization alarm. If not set, a default threshold of 99% is used.            | `95%`         |
| `autoalarm:cpu-percent-above-warning`    | Threshold for warning CPU utilization alarm. If not set, a default threshold of 97% is used.             | `90%`         |
| `autoalarm:cpu-percent-duration-time`    | Duration in seconds for CPU utilization to exceed the threshold before triggering the alarm.             | `60 seconds`  |
| `autoalarm:cpu-percent-duration-periods` | Number of consecutive periods over which data is evaluated against the specified threshold.              | `2 periods`   |
| `autoalarm:storage-used-percent-critical`| Threshold for critical storage utilization alarm. If not set, a default threshold of 90% is used.         | `95%`         |
| `autoalarm:storage-used-percent-warning` | Threshold for warning storage utilization alarm. If not set, a default threshold of 80% is used.          | `90%`         |
| `autoalarm:storage-percent-duration-time`| Duration in seconds for storage utilization to exceed the threshold before triggering the alarm.          | `60 seconds`  |
| `autoalarm:storage-percent-duration-periods`| Number of consecutive periods over which data is evaluated against the specified threshold.              | `2 periods`   |
| `autoalarm:memory-percent-above-critical`| Threshold for critical memory utilization alarm. If not set, a default threshold of 90% is used.          | `95%`         |
| `autoalarm:memory-percent-above-warning` | Threshold for warning memory utilization alarm. If not set, a default threshold of 80% is used.           | `90%`         |
| `autoalarm:memory-percent-duration-time` | Duration in seconds for memory utilization to exceed the threshold before triggering the alarm.           | `60 seconds`  |
| `autoalarm:memory-percent-duration-periods`| Number of consecutive periods over which data is evaluated against the specified threshold.              | `2 periods`   |
| `autoalarm:selective-storage`            | If set to "true", selective storage monitoring will be enabled. Default is "false".                      | `false`       |
| `Prometheus`                             | If set to "true", Prometheus rules will be created/updated for the instance. Default is "false".         | `false`       |

### Default Alarm Behavior

If the `autoalarm:cpu-percent-above-critical` and `autoalarm:cpu-percent-above-warning` tags are not present, alarms will be created with default thresholds of 99% for critical alarms and 97% for warning alarms, respectively. These default settings ensure that basic monitoring is in place even if specific customizations are not specified. This default behavior helps to maintain a baseline of operational awareness and prompt response capability.

## EventBridge Rules

The project configures AWS EventBridge to route specific events to the AutoAlarm Lambda function. Below are the detailed rules created:

### Tag Rule

| Description          | Value                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Event Source**     | `aws.tag`                                                                                                                                                                          |
| **Detail Type**      | Tag Change on Resource                                                                                                                                                             |
| **Service**          | EC2                                                                                                                                                                        |
| **Resource Type**    | Instance                                                                                                                                                                           |
| **Changed Tag Keys** | `autoalarm:disabled`, `autoalarm:cpu-percent-above-critical`, `autoalarm:cpu-percent-above-warning`, `autoalarm:cpu-percent-duration-time`, `autoalarm:cpu-percent-duration-periods`, `autoalarm:storage-used-percent-critical`, `autoalarm:storage-used-percent-warning`, `autoalarm:storage-percent-duration-time`, `autoalarm:storage-percent-duration-periods`, `autoalarm:memory-percent-above-critical`, `autoalarm:memory-percent-above-warning`, `autoalarm:memory-percent-duration-time`, `autoalarm:memory-percent-duration-periods`, `autoalarm:selective-storage`, `Prometheus` |

### EC2 State Change Rule

| Description      | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| **Event Source** | `aws.ec2`                                                      |
| **Detail Type**  | EC2 Instance State-change Notification                         |
| **States**       | `running`, `terminated`, `stopped`, `shutting-down`, `pending` |

## Prometheus Rules

### Supported Metrics for Prometheus Rules

- **CPU Utilization**: `100 - (rate(node_cpu_seconds_total{mode="idle", instance="${privateIp}"}[5m]) * 100)`
- **Memory Utilization** (Linux): `100 - ((node_memory_MemAvailable_bytes{instance="${privateIp}"} / node_memory_MemTotal_bytes{instance="${privateIp}"}) * 100)`
- **Memory Utilization** (Windows): `100 - ((windows_os_virtual_memory_free_bytes{instance="${privateIp}:9100"} / windows_os_virtual_memory_bytes{instance="${privateIp}:9100"}) * 100)`
- **Storage Utilization** (Linux): `100 - ((node_filesystem_avail_bytes{fstype!="tmpfs", instance="${privateIp}"} / node_filesystem_size_bytes{fstype!="tmpfs", instance="${privateIp}"}) * 100)`
- **Storage Utilization** (Windows): `100 - ((windows_logical_disk_free_bytes{instance="${privateIp}:9100"} / windows_logical_disk_size_bytes{instance="${privateIp}:9100"}) * 100)`

## IAM Role and Permissions

The Lambda execution role requires specific permissions to interact with AWS services:

- **Prometheus**: 
  - Actions: `aps:QueryMetrics`, `aps:ListRuleGroupsNamespaces`, `aps:DescribeRuleGroupsNamespace`, `aps:CreateRuleGroupsNamespace`, `aps:PutRuleGroupsNamespace`, `aps:DeleteRuleGroupsNamespace`
  - Resources: `arn:aws:aps:${region}:${accountId}:workspace/${prometheusWorkspaceId}`, `arn:aws:aps:${region}:${accountId}:*/${prometheusWorkspaceId}/*`

- **EC2 and CloudWatch**: 
  - Actions: `ec2:DescribeInstances`, `ec2:DescribeTags`, `cloudwatch:PutMetricAlarm`, `cloudwatch:DeleteAlarms`, `cloudwatch:DescribeAlarms`, `cloudwatch:ListMetrics`
  - Resources: `*`

- **CloudWatch Logs**: 
  - Actions: `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`
  - Resources: `*`

## Limitations

- Currently supports only EC2 instances. Extension to other services like ECS or RDS would require modifications to the Lambda function and CDK setup.
- Tag-based configuration may not be suitable for all use cases. Customization options are limited to the supported tags.
- Some alarms and rules are created by default even without tags, such as CPU utilization alarms, and can only be modified with the use of tags. Otherwise, they will be created with default values.

Please refer to the code files provided for more detailed information on the implementation and usage of the AutoAlarm system.

