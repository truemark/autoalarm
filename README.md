# AutoAlarm Project README

## Overview

AutoAlarm is an AWS Lambda-based automation tool designed to dynamically manage CloudWatch alarms for ALBs, EC2 
Instances, OpenSearch, SQS, and Target Groups based on instance states and specific tag values. The project uses AWS SDK 
for JavaScript v3, the AWS CDK for infrastructure deployment, and is integrated with AWS Lambda and CloudWatch for 
automated cloud observability.

## Architecture

The AutoAlarm project is designed to be deployed with minimal configuration, creating all necessary AWS resources for 
full functionality. Upon deployment, the project automatically provisions the following components:

- **IAM Roles and Policies**: Provides the necessary permissions for the Lambda functions to interact with AWS services 
like EC2, CloudWatch, SQS, and more.
- **Lambda Functions**: Core logic for AutoAlarm is handled by AWS Lambda, which manages the creation, updating, and 
deletion of CloudWatch alarms based on resource state and tag changes.
- **EventBridge Rules**: AutoAlarm uses Amazon EventBridge to listen for events across various services, such as EC2 
state changes and tag updates. These rules trigger the Lambda function to manage alarms dynamically based on the event 
data. These event triggers are what determine when alarms are created, updated, or deleted.
- **CloudWatch Log Groups**: Log groups are created to capture the logs generated by the Lambda functions, enabling easy 
monitoring and troubleshooting.
- **SQS Queues**: Dead-letter queues (DLQs) are set up using Amazon SQS to capture and manage failed Lambda function 
executions for further investigation and retry.
- **CloudWatch Alarms for Lambda Monitoring**: Alarms are created to monitor the performance and availability of the 
Lambda function itself, ensuring that any issues with alarm management are caught early.

This architecture ensures that AutoAlarm can monitor and manage resources out-of-the-box, including ALBs, EC2 instances, 
OpenSearch domains, SQS queues, and Target Groups. The system is fully event-driven, dynamically responding to state and 
tag changes across these resources.

### Special Considerations: 
- **Alerting**: If you are not a customer of the Truemark Enterprise Operations Center, you will need to configure Alarm
notification routing via SNS or other custom integrations.

## Deployment Process
### Prerequisites

Before you begin, ensure you have the following:

1. **AWS CLI**: Installed and configured with appropriate access to your AWS account.
2. **AWS CDK** 
3. **Node.js**
4. **Git**
5. **pnpm**: Version 9.1.4 or later. 

To set up and deploy the AutoAlarm project, follow these steps:

1. **Clone the Repository**

   Start by cloning the project repository to your local machine:

```bash
git clone https://github.com/truemark/autoalarm.git
cd autoalarm
```
   
2. **Install Dependencies**
```bash
pnpm install
```
3. **Configure Region**
```bash
export AWS_REGION=<region>
```
4. **Configure Keys and Session Token**
```bash
export AWS_ACCESS_KEY_ID="<access-key-id"
export AWS_SECRET_ACCESS_KEY="<secret-access-key>"
export AWS_SESSION_TOKEN="<aws-session-token>"
```
5. **Bootstrap the CDK**
```bash
cdk bootstrap
```
6. **Build the Project**
```bash
pnpm build
```  
7. **Deploy the Stack**
```bash
cd cdk ; cdk deploy AutoAlarm
```

## Features

- **Dynamic Alarm Management**: Automatically creates, updates, and deletes CloudWatch alarms based 
on EC2 instance states and tag changes.
- **CloudWatch Alarm Integration**: Supports creating both static threshold CloudWatch alarms and anomaly detection alarms.
- **Customization Through Tags**: Uses tags to define alarm thresholds and conditions, allowing per-instance 
customization. Tags can be dynamically updated to configure statistics for anomanly detection alarms, thresholds for 
warning and critical static threshold alarms, in addition to evaluation period length and number of periods.
- **Scalable and Extendable**: Designed to handle multiple instances and can be extended to support other AWS resources.

## AWS Services Used

### 1. Amazon CloudWatch
Amazon CloudWatch is utilized for monitoring and alerting. CloudWatch alarms are created, updated, or deleted by the 
Lambda function to track various metrics such as CPU utilization, memory usage, storage usage, ALB metrics, and Target 
Group metrics. CloudWatch Logs are also used to store log data generated by the Lambda function for debugging and 
auditing purposes.

### 2. Amazon EC2
Amazon EC2 is the primary service monitored by AutoAlarm. The Lambda function responds to state change notifications and 
tag change events for EC2 instances, creating or updating alarms based on the instance's state and tags.

### 3. Amazon EventBridge
Amazon EventBridge is used to route events to the Lambda function. Rules are set up to listen for specific events such 
as state changes, tag changes, and other resource events. These events trigger the Lambda function to perform the 
necessary alarm management actions. Additionally when using TrueMark's Enterprise Operation center eventbridge is 
monitored for triggered alarms eliminating the need to send them to a specific SNS topic.

### 4. Amazon Simple Queue Service (SQS)
Amazon SQS is used as a dead-letter queue for the Lambda function. If the Lambda function fails to process an event, 
the event is sent to an SQS queue for further investigation and retry.

### 5. AWS Elastic Load Balancing (ELB) And Target Groups
ELB is monitored by AutoAlarm for events related to Application Load Balancers (ALBs) and Target Groups. The Lambda 
function creates, updates, or deletes alarms for ALB metrics and target group metrics based on events and tags.

### 6. AWS OpenSearch Service (OS)
OS is monitored by AutoAlarm for events related to OpenSearch Service. The Lambda function creates, updates, or deletes 
alarms for OS metrics based on events and tags.

### 7. AWS Identity and Access Management (IAM)
IAM is used to define roles and policies that grant the necessary permissions to the Lambda function. These roles allow 
the function to interact with other AWS services such as CloudWatch, EC2, AMP, SQS, and EventBridge.

### 8. AWS Lambda
AWS Lambda is used to run the main AutoAlarm function, which processes service and tag events in addition to managing 
alarms. The Lambda function is responsible for handling the logic to create, update, or delete CloudWatch alarms and 
Prometheus rules based on tags and state changes.


## Usage

The system is event-driven, responding to EC2 state change notifications and tag modification events. To manage alarms 
, ensure your supported resources are tagged according to the schema defined below.

## Tag Values and Behaviour

### Overview
Tags are used to customize CloudWatch alarms for various AWS services managed by AutoAlarm. By applying specific tags to 
resources such as EC2 instances, ALBs, Target Groups, SQS, and OpenSearch, you can define custom thresholds, evaluation 
periods, and other parameters for both static threshold and anomaly detection alarms. The following sections outline the 
default configurations and explain how you can modify them using these tags.

### Default Values
AutoAlarm comes with predefined default values for various alarms. These defaults are designed to provide general 
monitoring out-of-the-box. However, it is crucial that any enabled alarms are reviewed to ensure they align with the 
specific needs of your application and environment. Default alarms can be created by setting the `autoalarm:enabled` tag
to `true` on the resource.

### Customizing Alarms with Tags

When setting up non-default alarms with tags, you must provide at least the first two values (warning and critical 
thresholds) for the tag to function correctly. If these thresholds are not supplied, the alarm will not be created 
unless defaults are defined.

The following schema is used to define tag values for all tags: 

```plaintext
Warning Threshold / Critical Threshold / Period / Evaluation Periods / Statistic / Datapoints to Alarm / ComparisonOperator / Missing Data Treatment
```

**Example:**

`autoalarm:cpu=80/95/60/5/Maximum/5/GreaterThanThreshold/ignore`


#### Static Threshold vs Anomaly Detection Alarms
All Anomaly alarm tags contain 'anomaly' in tag name. 

**Static Threshold Alarms**:
- Triggered when a metric crosses a fixed value.
  - Warning and Critical threshold represent the fixed threshold value.
- Suitable for metrics with consistent ranges.

**Anomaly Detection Alarms**:
- Triggered when a metric deviates from a dynamic range based on historical data.
  - Warning and Critical threshold represent the number of standard deviations outside of the band or range of the 
  anomaly model.
- For times when you want to detect outliers in your metrics and alarm on them.

### Supported Tag Values

#### Warning and Critical Thresholds:
- **Warning Threshold**: Numeric value at which a warning alarm is triggered.
- **Critical Threshold**: Numeric value at which a critical alarm is triggered.

#### Period:
- **Evaluation Period Duration**: The number of seconds over which the data is evaluated to determine if the alarm. 
Must be 10 seconds, 30 seconds, or a multiple of 60 seconds.

#### Data Points to Alarm:
- **Datapoints to Alarm**: The number of data points that must be breaching to trigger the alarm.

#### Number of Periods:
- **Datapoints to Alarm**: The number of data points that must be breaching to trigger the alarm.

#### Statistic:
You can use the following statistics for alarms - https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html.
- **SampleCount** is the number of data points during the period.
- **Sum** is the sum of the values of all data points collected during the period.
- **Average** is the value of `Sum/SampleCount` during the specified period.
- **Minimum** is the lowest value observed during the specified period.
- **Maximum** is the highest value observed during the specified period.
- **Percentile (p)** indicates the relative standing of a value in a dataset. For example, `p95` is the 95th percentile 
and means that 95 percent of the data within the period is lower than this value, and 5 percent of the data is higher 
than this value. Percentiles help you get a better understanding of the distribution of your metric data.
- **Trimmed mean (TM)** is the mean of all values that are between two specified boundaries. Values outside of the 
boundaries are ignored when the mean is calculated. You define the boundaries as one or two numbers between 0 and 100, 
up to 10 decimal places. The numbers can be absolute values or percentages. For example, `tm90` calculates the average 
after removing the 10% of data points with the highest values. `TM(2%:98%)` calculates the average after removing the 2% 
lowest data points and the 2% highest data points. `TM(150:1000)` calculates the average after removing all data points 
that are lower than or equal to 150, or higher than 1000.
- **Interquartile mean (IQM)** is the trimmed mean of the interquartile range, or the middle 50% of values. It is 
equivalent to `TM(25%:75%)`.
- **Winsorized mean (WM)** is similar to trimmed mean. However, with winsorized mean, the values that are outside the 
boundary are not ignored, but instead are considered to be equal to the value at the edge of the appropriate boundary. 
After this normalization, the average is calculated. You define the boundaries as one or two numbers between 0 and 100, 
up to 10 decimal places. For example, `wm98` calculates the average while treating the 2% of the highest values to be 
equal to the value at the 98th percentile. `WM(10%:90%)` calculates the average while treating the highest 10% of data 
points to be the value of the 90% boundary, and treating the lowest 10% of data points to be the value of the 10% boundary.
- **Percentile rank (PR)** is the percentage of values that meet a fixed threshold. For example, `PR(:300)` returns the 
percentage of data points that have a value of 300 or less. `PR(100:2000)` returns the percentage of data points that 
have a value between 100 and 2000. Percentile rank is exclusive on the lower bound and inclusive on the upper bound.
- **Trimmed count (TC)** is the number of data points in the chosen range for a trimmed mean statistic. For example, 
`tc90` returns the number of data points not including any data points that fall in the highest 10% of the values. 
`TC(0.005:0.030)` returns the number of data points with values between 0.005 (exclusive) and 0.030 (inclusive).
- **Trimmed sum (TS)** is the sum of the values of data points in a chosen range for a trimmed mean statistic. It is 
equivalent to `(Trimmed Mean) * (Trimmed count)`. For example, `ts90` returns the sum of the data points not including 
any data points that fall in the highest 10% of the values. `TS(80%:)` returns the sum of the data point values, not 
including any data points with values in the lowest 80% of the range of values.


#### Missing Data Treatment
- missing
- ignore
- breaching
- notBreaching

#### Valid Comparison Operators
**Static Threshold Alarms**
- `GreaterThanOrEqualToThreshold`
- `GreaterThanThreshold`
- `LessThanThreshold`
- `LessThanOrEqualToThreshold`

**Anomaly Detection Alarms**
- `GreaterThanUpperThreshold`
- `LessThanLowerOrGreaterThanUpperThreshold`
- `LessThanLowerThreshold`


### Tag Configuration for Supported Resources
Threshold values that contain '-' are undefined and will default to not creating the alarm if the warning and critical 
threshold values are not provided in the tag value when setting the tag on the resource.

#### Application Load Balancer (ALB) 

| Tag                               | Default Value                                          | Enabled By Default | Standard CloudWatch Metrics |
|-----------------------------------|--------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:4xx-count`             | "-/-/60/2/Sum/2/GreaterThanThreshold/ignore"           | No                 | Yes                         |
| `autoalarm:4xx-count-anomaly`     | "2/5/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         | 
| `autoalarm:5xx-count`             | "-/-/60/2/Sum/2/GreaterThanThreshold/ignore"           | No                 | Yes                         |
| `autoalarm:5xx-count-anomaly`     | "2/5/300/2/Average/2/GreaterThanUpperThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:request-count`         | "-/-/60/2/Sum/2/GreaterThanThreshold/ignore"           | No                 | Yes                         |
| `autoalarm:request-count-anomaly` | "3/5/300/2/Average/2/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |

#### EC2
Some Metrics require the CloudWatch Agent to be installed on the host.

| Tag                         | Default Value                                          | Enabled By Default | Standard CloudWatch Metrics                    |
|-----------------------------|--------------------------------------------------------|--------------------|------------------------------------------------|
| `autoalarm:cpu`             | "95/98/60/5/Maximum/5/GreaterThanThreshold/ignore"     | Yes                | Yes                                            |
| `autoalarm:cpu-anomaly`     | "2/5/60/5/Average/5/GreaterThanUpperThreshold/ignore"  | No                 | Yes                                            |
| `autoalarm:memory`          | "95/98/60/10/Maximum/10/GreaterThanThreshold/ignore"   | Yes                | No (Requires CloudWatch Agent Install on Host) |
| `autoalarm:memory-anomaly`  | "2/5/300/2/Average/2/GreaterThanUpperThreshold/ignore" | No                 | No (Requires CloudWatch Agent Install on Host) |
| `autoalarm:storage`         | "90/95/60/2/Maximum/1/GreaterThanThreshold/ignore"     | Yes                | No (Requires CloudWatch Agent Install on Host) |
| `autoalarm:storage-anomaly` | "2/3/60/2/Average/1/GreaterThanUpperThreshold/ignore"  | No                 | No (Requires CloudWatch Agent Install on Host) |

#### OpenSearch

| Tag                                     | Default Value                                          | Enabled By Default | Standard CloudWatch Metrics |
|-----------------------------------------|--------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:4xx-errors`                  | "100/300/300/1/Sum/1/GreaterThanThreshold/ignore"      | No                 | Yes                         |
| `autoalarm:4xx-errors-anomaly`          | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:5xx-errors`                  | "10/50/300/1/Sum/1/GreaterThanThreshold/ignore"        | Yes                | Yes                         |
| `autoalarm:5xx-errors-anomaly`          | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:cpu`                         | "98/98/300/1/Maximum/1/GreaterThanThreshold/ignore"    | Yes                | Yes                         |
| `autoalarm:cpu-anomaly`                 | "2/2/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:iops-throttle`               | "5/10/300/1/Sum/1/GreaterThanThreshold/ignore"         | Yes                | Yes                         |
| `autoalarm:iops-throttle-anomaly`       | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:jvm-memory`                  | "85/92/300/1/Maximum/1/GreaterThanThreshold/ignore"    | Yes                | Yes                         |
| `autoalarm:jvm-memory-anomaly`          | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:read-latency`                | "0.03/0.08/60/2/Maximum/2/GreaterThanThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:read-latency-anomaly`        | "2/6/300/2/Average/2/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:search-latency`              | "1/2/300/2/Average/2/GreaterThanThreshold/ignore"      | Yes                | Yes                         |
| `autoalarm:search-latency-anomaly`      | "-/-/300/2/Average/2/GreaterThanUpperThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:snapshot-failure`            | "-/1/300/1/Sum/1/GreaterThanOrEqualToThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:storage`                     | "10000/5000/300/2/Average/2/LessThanThreshold/ignore"  | Yes                | Yes                         |
| `autoalarm:storage-anomaly`             | "2/3/300/2/Average/2/GreaterThanUpperThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:throughput-throttle`         | "40/60/60/2/Sum/2/GreaterThanThreshold/ignore"         | No                 | Yes                         |
| `autoalarm:throughput-throttle-anomaly` | "3/5/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:write-latency`               | "84/100/60/2/Maximum/2/GreaterThanThreshold/ignore"    | Yes                | Yes                         |
| `autoalarm:write-latency-anomaly`       | "-/-/60/2/Average/2/GreaterThanUpperThreshold/ignore"  | No                 | Yes                         |
| `autoalarm:yellow-cluster`              | "-/1/300/1/Maximum/1/GreaterThanThreshold/ignore"      | Yes                | Yes                         |
| `autoalarm:red-cluster`                 | "-/1/60/1/Maximum/1/GreaterThanThreshold/ignore"       | Yes                | Yes                         |


#### Route 53 Resolver Endpoint

| Tag                                       | Default Value                                           | Enabled By Default | Standard CloudWatch Metrics |
|-------------------------------------------|---------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:inbound-query-volume`          | "6000/7000/300/1/Maximum/1/GreaterThanThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:inbound-query-volume-anomaly`  | "-/-/300/1/Maximum/1/GreaterThanUpperThreshold/ignore"  | No                 | Yes                         |
| `autoalarm:outbound-query-volume`         | "6000/7000/300/1/Maximum/1/GreaterThanThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:outbound-query-volume-anomaly` | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore"  | No                 | Yes                         |


#### SQS

| Tag                                       | Default Value                                          | Enabled By Default | Standard CloudWatch Metrics |
|-------------------------------------------|--------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:age-of-oldest-message`         | "-/-/300/1/Maximum/1/GreaterThanThreshold/ignore"      | No                 | Yes                         |
| `autoalarm:age-of-oldest-message-anomaly` | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:empty-receives`                | "-/-/300/1/Sum/1/GreaterThanThreshold/ignore"          | No                 | Yes                         |
| `autoalarm:empty-receives-anomaly`        | "-/-/300/1/Sum/1/GreaterThanUpperThreshold/ignore"     | No                 | Yes                         |
| `autoalarm:messages-deleted`              | "-/-/300/1/Sum/1/GreaterThanThreshold/ignore"          | No                 | Yes                         |
| `autoalarm:messages-deleted-anomaly`      | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:messages-not-visible`          | "-/-/300/1/Maximum/1/GreaterThanThreshold/ignore"      | No                 | Yes                         |
| `autoalarm:messages-not-visible-anomaly`  | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:messages-received`             | "-/-/300/1/Sum/1/GreaterThanThreshold/ignore"          | No                 | Yes                         |
| `autoalarm:messages-received-anomaly`     | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:messages-sent`                 | "-/-/300/1/Sum/1/GreaterThanThreshold/ignore"          | No                 | Yes                         |
| `autoalarm:messages-sent-anomaly`         | "1/1/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:messages-visible`              | "-/-/300/1/Maximum/1/GreaterThanThreshold/ignore"      | No                 | Yes                         |
| `autoalarm:messages-visible-anomaly`      | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:sent-message-size`             | "-/-/300/1/Average/1/GreaterThanThreshold/ignore"      | No                 | Yes                         |
| `autoalarm:sent-message-size-anomaly`     | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |


#### Target Groups (TG)

| Tag                               | Default Value                                          | Enabled By Default | Standard CloudWatch Metrics |
|-----------------------------------|--------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:4xx-count`             | "-/-/60/2/Sum/1/GreaterThanThreshold/ignore"           | No                 | Yes                         |
| `autoalarm:4xx-count-anomaly`     | "-/-/60/2/Average/1/GreaterThanUpperThreshold/ignore"  | No                 | Yes                         |
| `autoalarm:5xx-count`             | "-/-/60/2/Sum/1/GreaterThanThreshold/ignore"           | No                 | Yes                         |
| `autoalarm:5xx-count-anomaly`     | "3/6/60/2/Average/1/GreaterThanUpperThreshold/ignore"  | Yes                | Yes                         |
| `autoalarm:response-time`         | "3/5/60/2/p90/2/GreaterThanThreshold/ignore"           | No                 | Yes                         |
| `autoalarm:response-time-anomaly` | "2/5/300/2/Average/2/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:unhealthy-host-count`  | "-/1/60/2/Maximum/2/GreaterThanThreshold/ignore"       | Yes                | Yes                         |


#### Transit Gateway 
| Tag                          | Default Value                                                        | Enabled By Default | Standard CloudWatch Metrics |
|------------------------------|----------------------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:bytesin`          | "8000000000/10000000000/300/1/Maximum/1/GreaterThanThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:bytesin-anomaly`  | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore"               | No                 | Yes                         |
| `autoalarm:bytesout`         | "8000000000/10000000000/300/1/Maximum/1/GreaterThanThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:bytesout-anomaly` | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore"               | No                 | Yes                         |


### Default Alarm Behavior
AutoAlarm comes with default alarm configurations for various metrics. These default alarms are created when the 
corresponding tags are not present on the resources. The default alarms are designed to provide basic monitoring 
out-of-the-box. However, it is recommended to customize the alarms based on your specific requirements. 

- To enable AutoAlarm default alarms or configure any default on non-default alarm, ensure that the `autoalarm:enabled` 
tag is set to `true` on the resource.
- To disable AutoAlarm default alarms and/or delete all existing autoalarm alarms, set the `autoalarm:enabled` tag to 
`false` on the resource.
- To customize the default alarms, add the appropriate tags with the desired values to the resource.
- To enable specific non-default alarms, add the corresponding tags with the desired values to the resource.

## IAM Role and Permissions

The Lambda execution role requires specific permissions to interact with AWS services. These are created when the CDK 
project is deployed.:

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

- **OpenSearch**:
  - Actions: `es:DescribeElasticsearchDomain`, `es:ListTags`, `es:ListDomainNames`
  - Resources: `*`

## Limitations

- Currently, supports only EC2 instances, ALBs, Target Groups, SQS and Opensearch. Extension to other services like ECS 
or RDS would require modifications to the Lambda function and CDK setup.
- Tag-based configuration may not be suitable for all use cases. Customization options are limited to the supported tags.
- Some alarms and rules are created by default even without tags, such as CPU utilization alarms, and can only be 
modified with the use of tags. Otherwise, they will be created with default values.

Please refer to the code files provided for more detailed information on the implementation and usage of the AutoAlarm system.

