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
- **Anomaly Detection Integration**: Supports creating both standard CloudWatch alarms and anomaly detection alarms for specified metrics such as `HostCount`.
- **Customization Through Tags**: Uses tags to define alarm thresholds and conditions, allowing per-instance customization.
- **Scalable and Extendable**: Designed to handle multiple instances and can be extended to support other AWS resources.

## AWS Services Used

### 1. AWS Lambda
AWS Lambda is used to run the main AutoAlarm function, which processes service and tag events in addition to managing alarms. The Lambda function is responsible for handling the logic to create, update, or delete CloudWatch alarms and Prometheus rules based on tags and state changes.

### 2. Amazon CloudWatch
Amazon CloudWatch is utilized for monitoring and alerting. CloudWatch alarms are created, updated, or deleted by the Lambda function to track various metrics such as CPU utilization, memory usage, storage usage, ALB metrics, and Target Group metrics. CloudWatch Logs are also used to store log data generated by the Lambda function for debugging and auditing purposes.

### 3. Amazon EC2
Amazon EC2 is the primary service monitored by AutoAlarm. The Lambda function responds to state change notifications and tag change events for EC2 instances, creating or updating alarms based on the instance's state and tags.

### 4. Amazon Managed Service for Prometheus (AMP)
AMP is used for querying metrics and managing Prometheus rules. The Lambda function can create, update, or delete Prometheus rules in the specified Prometheus workspace based on the instance's metrics and tags. Prometheus metrics are used as an alternative to CloudWatch for monitoring.

### 5. Amazon EventBridge
Amazon EventBridge is used to route events to the Lambda function. Rules are set up to listen for specific events such as state changes, tag changes, and other resource events. These events trigger the Lambda function to perform the necessary alarm management actions.

### 6. Amazon Simple Queue Service (SQS)
Amazon SQS is used as a dead-letter queue for the Lambda function. If the Lambda function fails to process an event, the event is sent to an SQS queue for further investigation and retry.

### 7. AWS Identity and Access Management (IAM)
IAM is used to define roles and policies that grant the necessary permissions to the Lambda function. These roles allow the function to interact with other AWS services such as CloudWatch, EC2, AMP, SQS, and EventBridge.

### 8. AWS Elastic Load Balancing (ELB)
ELB is monitored by AutoAlarm for events related to Application Load Balancers (ALBs) and Target Groups. The Lambda function creates, updates, or deletes alarms for ALB metrics and target group metrics based on events and tags.

## Usage

The system is event-driven, responding to EC2 state change notifications and tag modification events. To manage alarms and Prometheus rules, ensure your EC2 instances are tagged according to the supported schema defined below.

## Supported Tags


| Tag                                    | Description                                                                                                             | Default Value                                               |
|----------------------------------------|-------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------|
| `autoalarm:enabled`                    | If set to "true", instance status check alarms will be created for the resource.                                        | `false`                                                     |
| `autoalarm:ec2-cpu`                    | WARNING threshold num \| CRITICAL threshold num \| duration time num \| duration periods num e.g., "90\|95\|60\|2".     | "90\|95\|60\|2"                                             |
| `autoalarm:ec2-storage`                | WARNING threshold num \| CRITICAL threshold num \| duration time num \| duration periods num e.g., "90\|95\|60\|2".     | "90\|95\|60\|2"                                             |
| `autoalarm:ec2-memory`                 | WARNING threshold num \| CRITICAL threshold num \| duration time num \| duration periods num e.g., "90\|95\|60\|2".     | "90\|95\|60\|2"                                             |
| `autoalarm:target`                     | Specifies whether to use CloudWatch or Prometheus for monitoring. Default is CloudWatch.                                | `Prometheus` if Promethesu workspace ID is passed to lambda |
| `autoalarm:alb-request-count`          | WARNING threshold num \| CRITICAL threshold num \| duration time num \| duration periods num e.g., "1500\|1750\|60\|2". | "1500\|1750\|60\|2"                                         |
| `autoalarm:alb-HTTPCode_ELB_4XX_Count` | WARNING threshold num \| CRITICAL threshold num \| duration time num \| duration periods num e.g., "1500\|1750\|60\|2". | "1500\|1750\|60\|2"                                         |
| `autoalarm:alb-HTTPCode_ELB_5XX`       | WARNING threshold num \| CRITICAL threshold num \| duration time num \| duration periods num e.g., "1500\|1750\|60\|2". | "1500\|1750\|60\|2"                                         |
| `autoalarm:TargetResponseTime`         | WARNING threshold num \| CRITICAL threshold num \| duration time num \| duration periods num e.g., "1500\|1750\|60\|2". | "1500\|1750\|60\|2"                                         |
| `autoalarm:HTTPCode_Target_4XX`        | WARNING threshold num \| CRITICAL threshold num \| duration time num \| duration periods num e.g., "1500\|1750\|60\|2". | "1500\|1750\|60\|2"                                         |
| `autoalarm:HTTPCode_Target_5XX`        | WARNING threshold num \| CRITICAL threshold num \| duration time num \| duration periods num e.g., "1500\|1750\|60\|2". | "1500\|1750\|60\|2"                                         |
| `autoalarm:sqs-NumberOfMessagesSent`   | WARNING threshold num \| CRITICAL threshold num \| duration time num \| duration periods num e.g., "500\|100\|60\|2".   | "500\|1000\|60\|2"                                          |
| `autoalarm:sqs-ApproximateNumberOfMessagesVisible`   | WARNING threshold num \| CRITICAL threshold num \| duration time num \| duration periods num e.g., "500\|100\|60\|2".   | "500\|1000\|60\|2"                                          |
| `autoalarm:sqs-ApproximateAgeOfOldestMessage`   | WARNING threshold num \| CRITICAL threshold num \| duration time num \| duration periods num e.g., "500\|100\|60\|2".   | "500\|1000\|60\|2"                                          |

### Default Alarm Behavior

If the `autoalarm:ec2-cpu` tag is not present, alarms will be created with default thresholds of 95% for critical alarms and 90% for warning alarms, respectively. These default settings ensure that basic monitoring is in place even if specific customizations are not specified. This default behavior helps to maintain a baseline of operational awareness and prompt response capability.

## EventBridge Rules

The project configures AWS EventBridge to route specific events to the AutoAlarm Lambda function. Below are the detailed rules created:

### Tag Rule

| Description          | Value                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Event Source**     | `aws.tag`                                                                                                                                                                          |
| **Detail Type**      | Tag Change on Resource                                                                                                                                                             |
| **Service**          | EC2, ECS, RDS, ELB, Target Group                                                                                                                                                   |
| **Resource Type**    | Instance, loadbalancer, targetgroup                                                                                                                                                |
| **Changed Tag Keys** | `autoalarm:enabled`, `autoalarm:ec2-cpu`, `autoalarm:ec2-storage`, `autoalarm:ec2-memory`, `autoalarm:target`, `autoalarm:alb-request-count`, `autoalarm:alb-HTTPCode_ELB_4XX_Count`, `autoalarm:alb-HTTPCode_ELB_5XX`, `autoalarm:TargetResponseTime`, `autoalarm:HTTPCode_Target_4XX`, `autoalarm:HTTPCode_Target_5XX` |

### EC2 State Change Rule

| Description      | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| **Event Source** | `aws.ec2`                                                      |
| **Detail Type**  | EC2 Instance State-change Notification                         |
| **States**       | `running`, `terminated`, `stopped`, `shutting-down`, `pending` |

### ALB Event Rule

| Description      | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| **Event Source** | `aws.elasticloadbalancing`                                     |
| **Detail Type**  | AWS API Call via CloudTrail                                    |
| **Event Names**  | `CreateLoadBalancer`, `DeleteLoadBalancer`                     |
### Target Group Event Rule

| Description      | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| **Event Source** | `aws.elasticloadbalancing`                                     |
| **Detail Type**  | AWS API Call via CloudTrail                                    |
| **Event Names**  | `CreateTargetGroup`, `DeleteTargetGroup`                       |

### SQS Event Rule

| Description      | Value                                                 |
| ---------------- |-------------------------------------------------------|
| **Event Source** | `aws.sqs`                                             |
| **Detail Type**  | AWS API Call via CloudTrail                           |
| **Event Names**  | `CreateQueue`, `DeleteQueue`, `TagQueue`, `UntagQueue` |


## Prometheus Rules

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

