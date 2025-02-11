# AutoAlarm Project README

## Overview

AutoAlarm is an AWS Lambda-based automation tool designed to dynamically manage CloudWatch alarms for ALBs, EC2
Instances, OpenSearch, SQS, and Target Groups based on instance states and specific tag values. The project uses AWS SDK
for JavaScript v3, the AWS CDK for infrastructure deployment, and is integrated with AWS Lambda and CloudWatch for
automated cloud observability. A key part of AutoAlarm is the reAlarm Lambda function, which is triggered every two
hours to automatically check CloudWatch alarms and reset those in the ALARM state that are not tied to Auto Scaling
actions. This process ensures that alarms re-alert to maintain visibility on resource health and mitigate missed alerts
and failures.

## Architecture

The AutoAlarm project is designed to be deployed with minimal configuration, creating all necessary AWS resources for
full functionality. Upon deployment, the project automatically provisions the following components:

- **IAM Roles and Policies**: Provides the necessary permissions for the Lambda functions to interact with AWS services
  like EC2, CloudWatch, SQS, and more.
- **Lambda Functions**: Core logic for AutoAlarm is handled by AWS Lambda, which manages the creation, updating, and
  deletion of CloudWatch alarms based on resource state and tag changes. AutoAlarm includes a reAlarm function that
  retriggers alarms in the ALARM state every two hours to ensure that alerts are not missed.
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
  customization. Tags can be dynamically updated to configure statistics for anomaly detection alarms, thresholds for
  warning and critical static threshold alarms, in addition to evaluation period length and number of periods.
- **Scalable and Extendable**: Designed to handle multiple instances and can be extended to support other AWS resources.

## AWS Services Used

### 1. Amazon CloudFront

CloudFront is monitored by AutoAlarm for events related to CloudFront distributions. The Lambda function creates,
updates, or deletes alarms for CloudFront metrics based on events and tags.

### 2. Amazon CloudWatch

Amazon CloudWatch is utilized for monitoring and alerting. CloudWatch alarms are created, updated, or deleted by the
Lambda function to track various metrics such as CPU utilization, memory usage, storage usage, ALB metrics, and Target
Group metrics. CloudWatch Logs are also used to store log data generated by the Lambda function for debugging and
auditing purposes. AutoAlarm also includes a ReAlarm function that runs every two hours to reset alarms in an alarm
state that are not tied to Auto Scaling actions. This helps reduce and mitigate missed alerts and failures by ensuring
that technicians and engineers are kept engaged in ongoing monitoring and alerting.

### 3. Amazon EC2

The main Lambda function responds to state change notifications and tag change events for EC2 instances, creating or
updating alarms based on the instance's state and tags.

### 4. Amazon EventBridge

Amazon EventBridge is used to route events to Lambda functions. Rules are set up to listen for specific events such as
state changes, tag changes, and other resource events. These events trigger the Lambda function to perform the necessary
alarm management actions. Additionally, when using TrueMark's Enterprise Operation Center, EventBridge is monitored for
triggered alarms, eliminating the need to send them to a specific SNS topic.

### 5. Amazon Managed Prometheus (AMP)

AMP is integrated with AutoAlarm to monitor custom metrics for various AWS resources. The Lambda function can create,
update, or delete alert rules within AMP based on specified metric thresholds. This integration allows for detailed,
real-time monitoring of application and infrastructure performance, leveraging Prometheus' powerful query language
(PromQL) to detect anomalies and trigger alerts. AutoAlarm ensures that alert rules are dynamically managed, keeping
monitoring configurations up to date as infrastructure changes.

### 6. Amazon Simple Queue Service (SQS)

Amazon SQS is used as a dead-letter queue for the Lambda function. If the Lambda function fails to process an event,
the event is sent to an SQS queue for further investigation and retry.

### 7. AWS Elastic Load Balancing (ELB) And Target Groups

ELB is monitored by AutoAlarm for events related to Application Load Balancers (ALBs) and Target Groups. The Lambda
function creates, updates, or deletes alarms for ALB metrics and target group metrics based on events and tags. Note that
the supported metrics for Target Groups require that the target group is associated with an ALB.

### 8. AWS Identity and Access Management (IAM)

IAM is used to define roles and policies that grant the necessary permissions to the Lambda function. These roles allow
the function to interact with other AWS services such as CloudWatch, EC2, AMP, SQS, and EventBridge.

### 9. AWS Lambda

AWS Lambda is used to run the main AutoAlarm function, which processes service and tag events in addition to managing
alarms. The Lambda function is responsible for handling the logic to create, update, or delete CloudWatch alarms and
Prometheus rules based on tags and state changes.

### 10. AWS OpenSearch Service (OS)

OS is monitored by AutoAlarm for events related to OpenSearch Service. The Lambda function creates, updates, or deletes
alarms for OS metrics based on events and tags.

### 11. AWS Route53Resolver

Route53Resolver is monitored by AutoAlarm for events related to Route53Resolver endpoints. The Lambda function creates,
updates, or deletes alarms for Route53Resolver metrics based on events and tags.

### 12. AWS TransitGateway

TransitGateway is monitored by AutoAlarm for events related to TransitGateway attachments. The Lambda function creates,
updates, or deletes alarms for TransitGateway metrics based on events and tags.

### 13. AWS VPN

VPN is monitored by AutoAlarm for events related to VPN connections. The Lambda function creates, updates, or
deletes alarms for VPN metrics based on events and tags.

## Usage

The system is event-driven, responding to state change notifications and tag modification events. To manage alarms,
ensure your supported resources are tagged according to the schema defined below.

## AutoAlarm Tag Values and Behaviour

### Prometheus Alarms Overview:

Currently, AutoAlarm only supports EC2 prometheus alarms for CPU, Memory, and Storage utilization. These are static
threshold alarms. Anomaly alarms are not supported. To use prometheus functionality a context variable with the
prometheus workspaceID must be set in the CDK deployment like so:

```bash
cdk deploy -c prometheusWorkspaceId='ws-11111111-7e2c-ffff-8009-c9fb233c73bd' AutoAlarm
```

#### Default Values and Behaviors:

By default, anytime an EC2 instance triggers AutoAlarm, if a prometheus workspaceID is set and instance is reporting
to Prometheus, AutoAlarm prefers prometheus and will create prometheus alarms for CPU, Memory, and Storage utilization.

If you explicitly want to use CloudWatch alarms for EC2 instances, you can set the `autoalarm:target` tag to `cloudwatch`
on the instance. Inversely, you can explicitly define `promehteus` as the target however, this is unnecessary as AutoAlarm
prefers and defaults to prometheus is a workspace ID is provided and the instance is reporting to prometheus.

Anytime Prometheus alarms are created, any existing cloudwatch alarms for that instance are deleted.

Prometheus alarms are created from the default configuration values for each default alarm if tags for those alarms are
not set or, values can be defined by setting the appropriate tags on the instance. These tag values are defined below
and are ubiquitous across both cloudwatch alarms and prometheus alarms.

It should be noted, however, while the Prometheus integration uses standard tagging to define alarm thresholds, it does
not support comparison operators beyond `GreaterThanThreshold` or data treatments like Cloudwatch alarms. The default
queries for the Prometheus alarms are as follows:

- CPU Utilization For Linux Instances: `100 - (rate(node_cpu_seconds_total{instance=~"(${PrivateIp}.*|${instanceId})", mode="idle"}[30s]) * 100) > ${threshold}`
- CPU Utilization For Windows Instances: `100 - (rate(windows_cpu_time_total{instance=~"(${PrivateIp}.*|${instanceId})", mode="idle"}[30s]) * 100) > ${threshold}`

- Memory Utilization for Linux Instances: `100 - (node_memory_MemAvailable_bytes{instance=~"(${PrivateIp}.*|${instanceId})"} / node_memory_MemTotal_bytes{instance=~"(${PrivateIp}.*|${instanceId})"} * 100) > ${threshold}`
- Memory Utilization for Windows Instances: `100 - (windows_memory_available_bytes{instance=~"(${PrivateIp}.*|${instanceId})"} / windows_memory_total_bytes{instance=~"(${PrivateIp}.*|${instanceId})"} * 100) > ${threshold}`

- Storage Utilization For Linux Instances: `100 - (node_filesystem_avail_bytes{instance=~"(${PrivateIp}.*|${instanceId})", mountpoint="/"} / node_filesystem_size_bytes{instance=~"(${PrivateIp}.*|${instanceId})", mountpoint="/"} * 100) > ${threshold}`
- Storage Utilization For Windows Instances: `100 - (windows_logical_disk_free_bytes{instance=~"(${PrivateIp}.*|${instanceId})", drive="C:"} / windows_logical_disk_size_bytes{instance=~"(${PrivateIp}.*|${instanceId})", drive="C:"} * 100) > ${threshold}`

AutoAlarm automatically pulls the privateIP Addresses, InstanceIDs and Platform of each instance and populates that
information into each query in addition to pulling the threshold from the default value or the tag values on the instance.

If an instance is explicitly configured for prometheus via tagging, but the instance is not reporting to prometheus,
AutoAlarm will intelligently detect any instance that is not reporting to prometheus and will create cloudwatch alarms as
a fallback.

### CloudWatch Alarm Overview

Tags are used to customize CloudWatch alarms for various AWS services managed by AutoAlarm. By applying specific tags to
resources such as EC2 instances, ALBs, Target Groups, SQS, and OpenSearch, you can define custom thresholds, evaluation
periods, and other parameters for both static threshold and anomaly detection alarms. The following sections outline the
default configurations and explain how you can modify them using these tags.

#### Default Values

AutoAlarm comes with predefined default values for various alarms. These defaults are designed to provide general
monitoring out-of-the-box. However, it is crucial that any enabled alarms are reviewed to ensure they align with the
specific needs of your application and environment. Default alarms can be created by setting the `autoalarm:enabled` tag
to `true` on the resource.

### Customizing Alarms with Tags

When setting up non-default alarms with tags, you must provide at least the first two values (warning and critical
thresholds) for the tag to function correctly. If these thresholds are not supplied, the alarm will not be created
unless defaults are defined in the table below.

Prometheus alarms will only pull Warning and critical thresholds and periods from the tags. All other values are specfic
to CloudWatch alarms and are not used in Prometheus alarms.

The following schema is used to define tag values for all Alarm Management tags:

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
    - Warning and Critical threshold represent the number of standard deviations outside the band or range of the
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
- **Trimmed mean (TM)** is the mean of all values that are between two specified boundaries. Values outside the
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

### AutoAlarm Tag Configuration for Supported Resources

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

#### CloudFront

| Tag                            | Default Value                                          | Enabled By Default | Standard CloudWatch Metrics |
|--------------------------------|--------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:4xx-errors`         | "100/300/300/1/Sum/1/GreaterThanThreshold/ignore"      | No                 | Yes                         |
| `autoalarm:4xx-errors-anomaly` | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:5xx-errors`         | "10/50/300/1/Sum/1/GreaterThanThreshold/ignore"        | Yes                | Yes                         |
| `autoalarm:5xx-errors-anomaly` | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |

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

#### Route53Resolver

| Tag                                       | Default Value                                          | Enabled By Default | Standard CloudWatch Metrics |
|-------------------------------------------|--------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:inbound-query-volume`          | "-/-/300/1/Sum/1/GreaterThanThreshold/ignore"          | No                 | Yes                         |
| `autoalarm:inbound-query-volume-anomaly`  | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:outbound-query-volume`         | "-/-/300/1/Sum/1/GreaterThanThreshold/ignore"          | No                 | Yes                         |
| `autoalarm:outbound-query-volume-anomaly` | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |

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

#### Transit Gateway (TGW)

| Tag                           | Default Value                                          | Enabled By Default | Standard CloudWatch Metrics |
|-------------------------------|--------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:bytes-in`          | "-/-/300/1/Maximum/1/GreaterThanThreshold/ignore"      | No                 | Yes                         |
| `autoalarm:bytes-in-anomaly`  | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:bytes-out`         | "-/-/300/1/Sum/1/GreaterThanThreshold/ignore"          | No                 | Yes                         |
| `autoalarm:bytes-out-anomaly` | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |

#### VPN

| Tag                              | Default Value                                       | Enabled By Default | Standard CloudWatch Metrics |
|----------------------------------|-----------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:tunnel-state`         | "0/0/300/1/Maximum/1/LessThanThreshold/ignore"      | No                 | Yes                         |
| `autoalarm:tunnel-state-anomaly` | "-/-/300/1/Average/1/LessThanLowerThreshold/ignore" | No                 | Yes                         |

### Default AutoAlarm Alarm Behavior

AutoAlarm comes with default alarm configurations for various metrics. These default alarms are created when the
corresponding tags are not present on the resources. The default alarms are designed to provide basic monitoring
out-of-the-box. However, it is recommended to customize the alarms based on your specific requirements.

- To enable AutoAlarm default alarms or configure any default on non-default alarm, ensure that the `autoalarm:enabled`
  tag is set to `true` on the resource.
- To disable AutoAlarm default alarms and/or delete all existing autoalarm alarms, set the `autoalarm:enabled` tag to
  `false` on the resource.
- To customize the default alarms, add the appropriate tags with the desired values to the resource.
- To enable specific non-default alarms, add the corresponding tags with the desired values to the resource.

## ReAlarm Tag Configuration and Behavior:

### Overview

The ReAlarm function is an AWS Lambda-based handler designed to monitor and reset CloudWatch alarms that are in an
"ALARM" state. It is an optional part of the AutoAlarm system, aimed at ensuring alarms are not missed or ignored. This
functionality is built with complex maintenance and infrastructure in mind and is a stop gap to prevent critical alarms
from being missed or ignored by causing said alarms to re-alert on a schedule. ReAlarm can be enabled or disabled globally.
Additionally, Alarms can individually be tagged to be excluded from the ReAlarm function.

### Special Note:

ReAlarm is hardcoded to NOT reset alarms associated with AutoScaling actions. This is to prevent the function from
interfering with scaling operations.

### Default Values

By default, the ReAlarm function is enabled. When ReAlarm is enabled, it runs on a default schedule of every 120 minutes.

### Configure ReAlarm Behavior with Tags

ReAlarm's behavior can be configured on a per alarm basis using tags.

-   **Customize ReAlarm Schedule**:
    -   The ReAlarm schedule by default runs every 120 minutes.
    -   ReAlarm can be customized to run at different intervals on a per-alarm basis by setting the `autoalarm:re-alarm-minutes`
        tag to a whole number value.


### Customizing ReAlarm with Tags

In addition to global controls, individual alarms can be excluded from being reset by ReAlarm. This is done using a specific tag:

-   **Tag to Exclude Alarms from ReAlarm**:
    -   Alarms can be tagged with `autoalarm:re-alarm-enabled=false` to exclude them from the ReAlarm process.
    -   When this tag is present on an alarm, ReAlarm will skip resetting it, regardless of its state.
    -   This is useful for alarms that should be managed manually or have specific conditions that should not trigger ReAlarm.

#### Example:

1. To prevent ReAlarm from resetting a particular alarm, add the following tag:

    - **Key**: `autoalarm:re-alarm-enabled`
    - **Value**: `false`

2. **Tagging via AWS Console**:

    - Navigate to the CloudWatch alarm.
    - Under the "Tags" section, add a new tag:
        - **Key**: `autoalarm:re-alarm-enabled`
        - **Value**: `false`

3. **Tagging via AWS CLI**:
    ```bash
    aws cloudwatch tag-resource --resource-arn arn:aws:cloudwatch:region:account-id:alarm/alarm-name --tags Key=autoalarm:re-alarm-disabled,Value=true
    ```

By configuring ReAlarm both globally and on a per-alarm basis, users have the flexibility to manage alarm behavior according to their needs, ensuring critical alerts are revisited without excessive manual intervention.

## IAM Role and Permissions

The Lambda execution role requires specific permissions to interact with AWS services. These are created when the CDK
project is deployed.:

- **EC2 and CloudWatch**:

    - Actions: `ec2:DescribeInstances`, `ec2:DescribeTags`, `cloudwatch:PutMetricAlarm`, `cloudwatch:DeleteAlarms`, `cloudwatch:DescribeAlarms`, `cloudwatch:SetAlarmState`, `cloudwatch:ListMetrics`
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

- **CloundFront**:

    - Actions: `cloudfront:GetDistribution`, `cloudfront:ListDistributions`, `cloudfront:ListTagsForResource`
    - Resources: `*`

- **TransitGateway**:

    - Actions: `ec2:DescribeTransitGateways`
    - Resources: `*`

- **Route53Resolver**:

    - Actions: `route53resolver:ListResolverEndpoints`, `route53resolver:ListTagsForResource`
    - Resources: `*`

- **VPN**:
    - Actions: `ec2:DescribeVpnConnections`
    - Resources: `*`

## Limitations

- Currently, supports only EC2 instances, Application Load Balancers (support does not currently extend to Network Load Balancers), Target Groups, SQS, Transit Gateway, VPN, Route53Resolver, CloudFront
  and OpenSearch. Extension to other services like ECS or RDS would require modifications to the Lambda function and CDK setup.
- Tag-based configuration may not be suitable for all use cases. Customization options are limited to the supported tags.
- Some alarms and rules are created by default even without tags, such as CPU utilization alarms, and can only be
  modified with the use of tags. Otherwise, they will be created with default values.

Please refer to the code files provided for more detailed information on the implementation and usage of the AutoAlarm system.
