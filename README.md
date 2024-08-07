# AutoAlarm Project README

## Overview

AutoAlarm is an AWS Lambda-based automation tool designed to dynamically manage CloudWatch alarms and Prometheus rules for EC2 instances, ALBs, and Target Groups based on instance states and specific tag values. The project uses AWS SDK for JavaScript v3, the AWS CDK for infrastructure deployment, and is integrated with AWS Lambda, CloudWatch, and Prometheus for operational functionality.

## Architecture

The project consists of several key components:

- `MainHandler`: A TypeScript-based Lambda function that handles EC2, CloudWatch, and Prometheus operations.
- `AutoAlarmConstruct`: A CDK construct that sets up the necessary AWS resources and permissions for the Lambda function.
- `MainFunction`: A class extending `ExtendedNodejsFunction` to configure Lambda function specifics.
- `AutoAlarmStack`: The CDK stack that deploys the constructs and manages dependencies.

## Features

- **Dynamic Alarm Management**: Automatically creates, updates, and deletes CloudWatch alarms and Prometheus rules based on EC2 instance states and tag changes.
- **Anomaly Detection Integration**: Supports creating both standard CloudWatch alarms and anomaly detection alarms for specified metrics such as `HostCount`. Anomaly detection alarms are created by default while static threshold cloudwatch alarms are created based on tags.
- **Customization Through Tags**: Uses tags to define alarm thresholds and conditions, allowing per-instance customization. Tags can be dynamically updated to configure statistics for anomanly detection alarms, thresholds for warning and critical static threshold alarms, in addition to evaluation period length and number of periods.
- **Scalable and Extendable**: Designed to handle multiple instances and can be extended to support other AWS resources.

## AWS Services Used

### 1. Amazon CloudWatch
Amazon CloudWatch is utilized for monitoring and alerting. CloudWatch alarms are created, updated, or deleted by the Lambda function to track various metrics such as CPU utilization, memory usage, storage usage, ALB metrics, and Target Group metrics. CloudWatch Logs are also used to store log data generated by the Lambda function for debugging and auditing purposes.

### 2. Amazon EC2
Amazon EC2 is the primary service monitored by AutoAlarm. The Lambda function responds to state change notifications and tag change events for EC2 instances, creating or updating alarms based on the instance's state and tags.

### 3. Amazon EventBridge
Amazon EventBridge is used to route events to the Lambda function. Rules are set up to listen for specific events such as state changes, tag changes, and other resource events. These events trigger the Lambda function to perform the necessary alarm management actions.

### 4. Amazon Managed Service for Prometheus (AMP)
AMP is used for querying metrics and managing Prometheus rules. The Lambda function can create, update, or delete Prometheus rules in the specified Prometheus workspace based on the instance's metrics and tags. Prometheus metrics are used as an alternative to CloudWatch for monitoring.

### 5. Amazon Simple Queue Service (SQS)
Amazon SQS is used as a dead-letter queue for the Lambda function. If the Lambda function fails to process an event, the event is sent to an SQS queue for further investigation and retry.

### 6. AWS Elastic Load Balancing (ELB) And Target Groups
ELB is monitored by AutoAlarm for events related to Application Load Balancers (ALBs) and Target Groups. The Lambda function creates, updates, or deletes alarms for ALB metrics and target group metrics based on events and tags.

### 7. AWS Identity and Access Management (IAM)
IAM is used to define roles and policies that grant the necessary permissions to the Lambda function. These roles allow the function to interact with other AWS services such as CloudWatch, EC2, AMP, SQS, and EventBridge.

### 8. AWS Lambda
AWS Lambda is used to run the main AutoAlarm function, which processes service and tag events in addition to managing alarms. The Lambda function is responsible for handling the logic to create, update, or delete CloudWatch alarms and Prometheus rules based on tags and state changes.


## Usage

The system is event-driven, responding to EC2 state change notifications and tag modification events. To manage alarms and Prometheus rules, ensure your EC2 instances are tagged according to the supported schema defined below.

## Supported Tags
Note that tagging format is different for ALBs, Target Groups and SQS which require a '/' delimiter in place of the '|' delimiter used for EC2 instances. This is a limitation on the AWS side.

| Tag                                           | Default Value             | Enabled By Default | CloudWatch Only                 |
|-----------------------------------------------|---------------------------|--------------------|---------------------------------|
| `autoalarm:enabled`                           | `false`                   | No                 | N/A                             |
| `autoalarm:alb-4xx-count`                     | "-\/-\/60\/2\/Sum         | No                 | Yes                             |
| `autoalarm:alb-4xx-count-anomaly`             | "p90/60/2"                | No                 | Yes                             | 
| `autoalarm:alb-5xx-count`                     | "-\/-\/60\/2\/Sum         | No                 | Yes                             |
| `autoalarm:alb-5xx-count-anomaly`             | "p90/60/2"                | Yes                | Yes                             |
| `autoalarm:alb-request-count`                 | "-\/-\/60\/2\\/Sum        | No                 | Yes                             |
| `autoalarm:alb-request-count-anomaly`         | "p90/60/2"                | No                 | Yes                             |
| `autoalarm:ec2-cpu`                           | "95\/98\/300\/2\/p90"     | Yes                | No                              |
| `autoalarm:ec2-cpu-anomaly`                   | "p90\|60\|2"              | No                 | Yes                             |
| `autoalarm:ec2-memory`                        | "96\/98\/300\/2\/p90"     | Yes                | No                              |
| `autoalarm:ec2-memory-anomaly` c              | "p90\|60\|2"              | No                 | Yes (Requires CloudWatch Agent) |
| `autoalarm:ec2-storage`                       | "96\/98\/300\/2\/Maximum" | Yes                | No                              |
| `autoalarm:ec2-storage-anomaly`               | "p90\|60\|2"              | No                 | Yes (Requires CloudWatch Agent) |
| `autoalarm:sqs-empty-receives`                | "-\/-\/300\/1\/Sum"       | No                 | Yes                             |
| `autoalarm:sqs-empty-receives-anomaly`        | "Sum\/300\/1"             | No                 | Yes                             |
| `autoalarm:sqs-messages-delayed`              | "-\/-\/300\/1\/Maximum"   | No                 | Yes                             |
| `autoalarm:sqs-messages-delayed-anomaly`      | "Maximum\/300\/1"         | No                 | Yes                             |
| `autoalarm:sqs-messages-deleted`              | "-\/-\/300\/1\/Sum"       | No                 | Yes                             |
| `autoalarm:sqs-messages-deleted-anomaly`      | "Sum\/300\/1"             | No                 | Yes                             |
| `autoalarm:sqs-messages-not-visible`          | "-\/-\/300\/1\/Maximum"   | No                 | Yes                             |
| `autoalarm:sqs-messages-not-visible-anomaly`  | "Maximum\/300\/1"         | No                 | Yes                             |
| `autoalarm:sqs-messages-received`             | "-\/-\/300\/1\/Sum"       | No                 | Yes                             |
| `autoalarm:sqs-messages-received-anomaly`     | "Sum\/300\/1"             | No                 | Yes                             |
| `autoalarm:sqs-messages-sent`                 | "-\/-\/300\/1\/Sum"       | No                 | Yes                             |
| `autoalarm:sqs-messages-sent-anomaly`         | "Sum\/300\/1"             | No                 | Yes                             |
| `autoalarm:sqs-messages-visible`              | "-\/-\/300\/1\/Maximum"   | No                 | Yes                             |
| `autoalarm:sqs-messages-visible-anomaly`      | "Maximum\/300\/1"         | Yes                | Yes                             |
| `autoalarm:sqs-sent-messsge-size`             | "-\/-\/300\/1\/Average"   | No                 | Yes                             |
| `autoalarm:sqs-sent-message-size-anomaly`     | "Average\/300\/1"         | No                 | Yes                             |
| `autoalarm:sqs-age-of-oldest-message`         | "-\/-\/300\/1\/Maximum"   | No                 | Yes                             |
| `autoalarm:sqs-age-of-oldest-message-anomaly` | "Maximum\/300\/1"         | Yes                | Yes                             |
| `autoalarm:tg-4xx-count`                      | "-\/-\/60\/2\/Sum"        | No                 | Yes                             |
| `autoalarm:tg-4xx-count-anomaly`              | "p90/60/2"                | No                 | Yes                             |
| `autoalarm:tg-5xx-count`                      | "-\/-\/60\/2\/Sum"        | No                 | Yes                             |
| `autoalarm:tg-5xx-count-anomaly`              | "p90/60/2"                | Yes                | Yes                             |
| `autoalarm:tg-request-count`                  | "-\/-\/60\/2\/Sum"        | No                 | Yes                             |
| `autoalarm:tg-request-count-anomaly`          | "p90/60/2"                | No                 | Yes                             |
| `autoalarm:tg-response-time`                  | "-\/-\/60\/2\/p90"        | No                 | Yes                             |
| `autoalarm:tg-response-time-anomaly`          | "p90/60/2"                | Yes                | Yes                             |
| `autoalarm:tg-unhealthy-host-count`           | "-\/1\/60\/3\/Sum"        | Yes                | Yes                             |
| `autoalarm:tg-unhealthy-host-count-anomaly`   | "p90/60/2"                | No                 | Yes                             |



### Default Alarm Behavior

Tags are organized alarm types, service and metrics. Anomaly detection alarms are created by default while static threshold cloudwatch alarms are created based on tags. Staic threshold tags have default values in the case that an incorrect value is parsed in the warning or critical fields but are otherwise not set if those fields are empty or the tag does not exist. Additionally, Anomaly alarms are configured to alert on data above the 90th percentile historical data over 2 evaluations periods at 60 seconds each. The default percentile, period duration and number of periods can also be configured with tag values

### Example Tag Configuration For EC2

```json
{
    "autoalarm:enabled": "true",
    "autoalarm:cw-ec2-cpu": "90|95|60|2",
    "autoalarm:cw-ec2-storage": "90|95|60|2",
    "autoalarm:cw-ec2-memory": "90|95|60|2",
    "autoalarm:anomaly-ec2-cpu": "p90|60|2",
    "autoalarm:anomaly-ec2-storage": "p90|60|2",
    "autoalarm:anomaly-ec2-memory": "p90|60|2",
    "autoalarm:target": "Prometheus"
}
```

### Example Tag Configuration For ALB

```json
{
    "autoalarm:enabled": "true",
    "autoalarm:cw-alb-request-count": "1500/1750/60/2",
    "autoalarm:cw-alb-4xx-count": "1500/1750/60/2",
    "autoalarm:cw-alb-5xx-count": "1500/1750/60/2",
    "autoalarm:anomaly-alb-request-count": "p90/60/2",
    "autoalarm:anomaly-alb-4xx-count": "p90/60/2",
    "autoalarm:anomaly-alb-5xx-count": "p90/60/2",
    "autoalarm:target": "Prometheus"
}
```
## EventBridge Rules

The project configures AWS EventBridge to route specific events to the AutoAlarm Lambda function. The following rules are set up to trigger the Lambda function based on state changes and tag modifications:

| Rule Name          | Event Source             | Detail Type                            | Detail                                                                                                         | Description                                 |
|--------------------|--------------------------|----------------------------------------|----------------------------------------------------------------------------------------------------------------|---------------------------------------------|
| TagRule            | aws.tag                  | Tag Change on Resource                 | service: ['ec2', 'ecs', 'rds']<br>resource-type: ['instance']<br>changed-tag-keys: [various keys]              | Routes tag events to AutoAlarm              |
| Ec2Rule            | aws.ec2                  | EC2 Instance State-change Notification | state: ['running', 'terminated']                                                                               | Routes ec2 instance events to AutoAlarm     |
| AlbTagRule         | aws.tag                  | Tag Change on Resource                 | service: ['elasticloadbalancing']<br>resource-type: ['loadbalancer']<br>changed-tag-keys: [various keys]       | Routes ALB tag events to AutoAlarm          |
| AlbRule            | aws.elasticloadbalancing | Alb creation or deletion               | eventSource: ['elasticloadbalancing.amazonaws.com']<br>eventName: ['CreateLoadBalancer', 'DeleteLoadBalancer'] | Routes ALB events to AutoAlarm              |
| TargetGroupTagRule | aws.tag                  | Tag Change on Resource                 | service: ['elasticloadbalancing']<br>resource-type: ['targetgroup']<br>changed-tag-keys: [various keys]        | Routes Target Group tag events to AutoAlarm |
| TargetGroupRule    | aws.elasticloadbalancing | Target Group Creation or Deletion      | eventSource: ['elasticloadbalancing.amazonaws.com']<br>eventName: ['CreateTargetGroup', 'DeleteTargetGroup']   | Routes Target Group events to AutoAlarm     |
| SqsTagRule         | aws.tag                  | Tag Change on Resource                 | service: ['sqs']<br>resource-type: ['queue']<br>changed-tag-keys: [various keys]                               | Routes SQS tag events to AutoAlarm          |
| SqsRule            | aws.sqs                  | Queue Creation or Deletion             | eventSource: ['sqs.amazonaws.com']<br>eventName: ['CreateQueue', 'DeleteQueue', 'TagQueue', 'UntagQueue']      | Routes SQS events to AutoAlarm              |

## Prometheus Rules (in Progress-Not Yet Implemented)

### Supported Metrics for Prometheus Rules

- **CPU Utilization**
- **Memory Utilization**
- **Storage Utilization**

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

- **Elasic Load Balancing**:
  - Actions: `elasticloadbalancing:DescribeLoadBalancers`, `elasticloadbalancing:DescribeTargetGroups`, `elasticloadbalancing:DescribeTags`, `elasticloadbalancing:DescribeTargetHealth`
  - Resources: `*`

- **SQS**:
  - Actions: `sqs:GetQueueAttributes`, `sqs:ListQueues`, `sqs:ListQueueTags`, `sqs:TagQueue`
  - Resources: `*`

## Limitations

- Currently supports only EC2 instances, ALBs, Target Groups and SQS. Extension to other services like ECS or RDS would require modifications to the Lambda function and CDK setup.
- Tag-based configuration may not be suitable for all use cases. Customization options are limited to the supported tags.
- Some alarms and rules are created by default even without tags, such as CPU utilization alarms, and can only be modified with the use of tags. Otherwise, they will be created with default values.

Please refer to the code files provided for more detailed information on the implementation and usage of the AutoAlarm system.

