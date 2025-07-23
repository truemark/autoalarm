# AutoAlarm Project README

## Deployment Process

### Prerequisites

Before you begin, ensure you have the following:

1. **AWS CLI**: Installed and configured with appropriate access to your AWS account.
2. **AWS CDK**
3. **Node.js**: Version 22.x+.
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


## Usage

### AutoAlarm Tag Values and Alarm Creation Behavior

## Default Alarm Configuration

AutoAlarm provides out-of-the-box monitoring with sensible defaults while allowing full customization through resource tags.

### Managing AutoAlarm

| Tag Key             | Tag Value | Result                                                                                                              |
|---------------------|-----------|---------------------------------------------------------------------------------------------------------------------|
| `autoalarm:enabled` | `true`    | Enabled AutoAlarm Alarm Management for a resource and creates all default alarms - ***Required to use AutoAlarm**   |
| `autoalarm:enabled` | `false`   | Deletes all AutoAlarm managed alarms (both default and custom alarms). Alternatively, the tag can simply be removed |


### Configuration Priority

1. **Tagged values** - Always take precedence
2. **Default values** - Applied when tags are absent or when some values are missing from the tag value in which case autoalarm will pull the default for that value. 
3. **No alarm** - Alarms are not created when the `autoalarm:enabled` tag is not present or set to false and/or a non-default alarm is not defined in a tag.

Resources must be tagged according to the schema defined below to enable alarm management.

## AutoAlarm Default Tag Configuration for Supported Resources

The following schema is used to define tag values for all Alarm Management tags:

| Tag Key                              | Tag Value                                                                                                                                              |
|--------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------|
| `autoalarm:some-metric-type`         | `Warning Threshold / Critical Threshold / Period / Evaluation Periods / Statistic / Datapoints to Alarm / ComparisonOperator / Missing Data Treatment` |
| `autoalarm:some-metric-type-anomaly` | `Warning Threshold / Critical Threshold / Period / Evaluation Periods / Statistic / Datapoints to Alarm / ComparisonOperator / Missing Data Treatment` |

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

| Tag                             | Default Value                                          | Enabled By Default | Standard CloudWatch Metrics                    |
|---------------------------------|--------------------------------------------------------|--------------------|------------------------------------------------|
| `autoalarm:cpu`                 | "95/98/60/5/Maximum/5/GreaterThanThreshold/ignore"     | Yes                | Yes                                            |
| `autoalarm:cpu-anomaly`         | "2/5/60/5/Average/5/GreaterThanUpperThreshold/ignore"  | No                 | Yes                                            |
| `autoalarm:memory`              | "95/98/60/10/Maximum/10/GreaterThanThreshold/ignore"   | Yes                | No (Requires CloudWatch Agent Install on Host) |
| `autoalarm:memory-anomaly`      | "2/5/300/2/Average/2/GreaterThanUpperThreshold/ignore" | No                 | No (Requires CloudWatch Agent Install on Host) |
| `autoalarm:storage`             | "90/95/60/2/Maximum/1/GreaterThanThreshold/ignore"     | Yes                | No (Requires CloudWatch Agent Install on Host) |
| `autoalarm:storage-anomaly`     | "2/3/60/2/Average/1/GreaterThanUpperThreshold/ignore"  | No                 | No (Requires CloudWatch Agent Install on Host) |
| `autoalarm:network-in`          | "-/-/60/5/Sum/5/LessThanThreshold/ignore"              | No                 | Yes                                            |
| `autoalarm:network-in-anomaly`  | "2/5/60/5/Average/5/LessThanLowerThreshold/ignore"     | No                 | Yes                                            |
| `autoalarm:network-out`         | "-/-/60/5/Sum/5/LessThanThreshold/ignore"              | No                 | Yes                                            |
| `autoalarm:network-out-anomaly` | "2/5/60/5/Sum/5/LessThanLowerThreshold/ignore"         | No                 | Yes                                            |

#### OpenSearch

| Tag                                     | Default Value                                           | Enabled By Default | Standard CloudWatch Metrics |
|-----------------------------------------|---------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:4xx-errors`                  | "100/300/300/1/Sum/1/GreaterThanThreshold/ignore"       | No                 | Yes                         |
| `autoalarm:4xx-errors-anomaly`          | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore"  | No                 | Yes                         |
| `autoalarm:5xx-errors`                  | "10/50/300/1/Sum/1/GreaterThanThreshold/ignore"         | Yes                | Yes                         |
| `autoalarm:5xx-errors-anomaly`          | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore"  | No                 | Yes                         |
| `autoalarm:cpu`                         | "98/98/300/1/Maximum/1/GreaterThanThreshold/ignore"     | Yes                | Yes                         |
| `autoalarm:cpu-anomaly`                 | "2/2/300/1/Average/1/GreaterThanUpperThreshold/ignore"  | No                 | Yes                         |
| `autoalarm:iops-throttle`               | "5/10/300/1/Sum/1/GreaterThanThreshold/ignore"          | Yes                | Yes                         |
| `autoalarm:iops-throttle-anomaly`       | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore"  | No                 | Yes                         |
| `autoalarm:jvm-memory`                  | "85/92/300/1/Maximum/1/GreaterThanThreshold/ignore"     | Yes                | Yes                         |
| `autoalarm:jvm-memory-anomaly`          | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore"  | No                 | Yes                         |
| `autoalarm:read-latency`                | "0.03/0.08/60/2/Maximum/2/GreaterThanThreshold/ignore"  | Yes                | Yes                         |
| `autoalarm:read-latency-anomaly`        | "2/6/300/2/Average/2/GreaterThanUpperThreshold/ignore"  | No                 | Yes                         |
| `autoalarm:search-latency`              | "1/2/300/2/Average/2/GreaterThanThreshold/ignore"       | Yes                | Yes                         |
| `autoalarm:search-latency-anomaly`      | "-/-/300/2/Average/2/GreaterThanUpperThreshold/ignore"  | Yes                | Yes                         |
| `autoalarm:snapshot-failure`            | "-/1/300/1/Sum/1/GreaterThanOrEqualToThreshold/ignore"  | Yes                | Yes                         |
| `autoalarm:storage`                     | "10000/5000/300/2/Average/2/LessThanThreshold/ignore"   | Yes                | Yes                         |
| `autoalarm:storage-anomaly`             | "2/3/300/2/Average/2/GreaterThanUpperThreshold/ignore"  | Yes                | Yes                         |
| `autoalarm:throughput-throttle`         | "40/60/60/2/Sum/2/GreaterThanThreshold/ignore"          | No                 | Yes                         |
| `autoalarm:throughput-throttle-anomaly` | "3/5/300/1/Average/1/GreaterThanUpperThreshold/ignore"  | No                 | Yes                         |
| `autoalarm:write-latency`               | "84/100/60/2/Maximum/2/GreaterThanThreshold/ignore"     | Yes                | Yes                         |
| `autoalarm:write-latency-anomaly`       | "-/-/60/2/Average/2/GreaterThanUpperThreshold/ignore"   | No                 | Yes                         |
| `autoalarm:yellow-cluster`              | "-/1/300/1/Maximum/1/GreaterThanThreshold/ignore"       | Yes                | Yes                         |
| `autoalarm:red-cluster`                 | "-/1/60/1/Maximum/1/GreaterThanThreshold/ignore"        | Yes                | Yes                         |
| `autoalarm:index-writes-blocked`        | "-/1/600/1/Maximum/1/GreaterThanThreshold/notBreaching" | no                 | yes                         | 

#### RDS

| Tag                                  | Default Value                                                     | Enabled By Default | Standard CloudWatch Metrics |
|--------------------------------------|-------------------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:cpu`                      | "90/95/60/10/Maximum/8/GreaterThanThreshold/ignore"               | No                 | Yes                         |
| `autoalarm:db-connections-anomaly`   | "2/5/60/20/Maximum/16/GreaterThanUpperThreshold/ignore"           | Yes                | Yes                         |
| `autoalarm:dbload-anomaly`           | "2/5/60/25/Maximum/20/GreaterThanUpperThreshold/ignore"           | Yes                | Yes                         |
| `autoalarm:deadlocks`                | "-/0/60/2/Sum/2/GreaterThanThreshold/ignore"                      | Yes                | Yes                         |
| `autoalarm:disk-queue-depth`         | "4/8/60/20/Maximum/15/GreaterThanThreshold/ignore"                | No                 | Yes                         |
| `autoalarm:disk-queue-depth-anomaly` | "2/4/60/12/Sum/9/GreaterThanUpperThreshold/ignore"                | Yes                | Yes                         |
| `autoalarm:freeable-memory`          | "512000000/256000000/300/3/Minimum/2/LessThanThreshold/ignore"    | No                 | Yes                         |
| `autoalarm:freeable-memory-anomaly`  | "2/3/300/3/Minimum/2/LessThanLowerThreshold/ignore"               | Yes                | Yes                         |
| `autoalarm:replica-lag`              | "60/300/120/1/Maximum/1/GreaterThanThreshold/ignore"              | Yes                | Yes                         |
| `autoalarm:replica-lag-anomaly`      | "2/5/120/1/Average/1/GreaterThanUpperThreshold/ignore"            | Yes                | Yes                         |
| `autoalarm:swap-usage`               | "100000000/256000000/300/3/Maximum/3/GreaterThanThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:write-latency`            | "0.5/1/60/12/Maximum/9/GreaterThanUpperThreshold/ignore"          | No                 | Yes                         |
| `autoalarm:write-latency-anomaly`    | "2/4/60/12/Maximum/9/GreaterThanUpperThreshold/ignore"            | No                 | Yes                         |
| `autoalarm:write-througput-anomaly`  | "2/4/60/12/Maximum/9/GreaterThanUpperThreshold/ignore"            | No                 | Yes                         |
| `autoalarm:read-latency`             | "1/2/60/12/Maximum/9/GreaterThanThreshold/ignore"                 | No                 | Yes                         |
| `autoalarm:read-latency-anomaly`     | "2/4/60/12/Maximum/9/GreaterThanUpperThreshold/ignore"            | No                 | Yes                         |
| `autoalarm:read-throughput-anomaly`  | "2/4/60/12/Maximum/9/GreaterThanThreshold/ignore"                 | No                 | Yes                         |



#### RDS Clusters

| Tag                                | Default Value                                          | Enabled By Default | Standard CloudWatch Metrics |
|------------------------------------|--------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:db-connections-anomaly` | "2/5/600/5/Average/5/GreaterThanUpperThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:failover-state`         | "0/1/60/1/Maximum/1/GreaterThanThreshold/notBreaching" | No                 | Yes                         |
| `autoalarm:replica-lag-anomaly`    | "2/5/120/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |

#### Route53Resolver

| Tag                                       | Default Value                                             | Enabled By Default | Standard CloudWatch Metrics |
|-------------------------------------------|-----------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:inbound-query-volume`          | "1500000/2000000/300/1/Sum/1/GreaterThanThreshold/ignore" | Yes                | Yes                         |
| `autoalarm:inbound-query-volume-anomaly`  | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore"    | No                 | Yes                         |
| `autoalarm:outbound-query-volume`         | "1500000/2000000/300/1/Sum/1/GreaterThanThreshold/ignore" | No                 | Yes                         |
| `autoalarm:outbound-query-volume-anomaly` | "-/-/300/1/Average/1/GreaterThanUpperThreshold/ignore"    | No                 | Yes                         |

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

#### Step Functions

| Tag                                      | Default Value                                         | Enabled By Default | Standard CloudWatch Metrics |
|------------------------------------------|-------------------------------------------------------|--------------------|-----------------------------|
| `autoalarm:executions-failed`            | "-/1/60/1/Sum/1/GreaterThanThreshold/ignore"          | Yes                | Yes                         |
| `autoalarm:executions-failed-anomaly`    | "-/-/60/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |
| `autoalarm:executions-timed-out`         | "-/1/60/1/Sum/1/GreaterThanThreshold/ignore"          | Yes                | Yes                         |
| `autoalarm:executions-timed-out-anomaly` | "-/-/60/1/Average/1/GreaterThanUpperThreshold/ignore" | No                 | Yes                         |


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
| `autoalarm:unhealthy-host-count`  | "-/1/60/2/Maximum/2/LessThanThreshold/ignore"          | Yes                | Yes                         |

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


## Guide to Customizing Alarms with Tags

When setting up non-default alarms with tags, you must provide at least one of the first two values (warning and critical
thresholds) for the tag to function correctly. If these thresholds are not supplied, the alarm will not be created
unless defaults are defined in the tables above and the alarm is enabled by default.

Prometheus alarms will only pull Warning and critical thresholds and periods from the tags. All other values are specific
to CloudWatch alarms and are not used in Prometheus alarms.

**Example:**

| Tag Key                 | Tag Value                                                |
|-------------------------|----------------------------------------------------------|
| `autoalarm:cpu`         | `80/95/60/5/Maximum/5/GreaterThanThreshold/ignore`       |
| `autoalarm:cpu-anomaly` | `2/3/60/5/Maximum/5/GreaterThanUpperThreshold/breaching` |


## Alarm Types

### Static Threshold Alarms
- Trigger when metrics cross fixed values
- Best for metrics with consistent, predictable ranges

### Anomaly Detection Alarms
- Trigger when metrics deviate from historical patterns
- Use tag names containing 'anomaly'
- Threshold values represent standard deviations from the baseline

### Supported Tag Values

#### Threshold Configuration

| Parameter | Static Threshold Alarms | Anomaly Detection Alarms |
|-----------|------------------------|--------------------------|
| **Warning Threshold** | Numeric value that triggers warning (e.g., `80` for 80% CPU) | Number of standard deviations from baseline (e.g., `2`) |
| **Critical Threshold** | Numeric value that triggers critical alert (e.g., `95` for 95% CPU) | Number of standard deviations from baseline (e.g., `3`) |

#### Timing Configuration

| Parameter               | Description                                               | Valid Values                                                           | Example           |
|-------------------------|-----------------------------------------------------------|------------------------------------------------------------------------|-------------------|
| **Period**              | Duration in seconds for data evaluation                   | • 10 seconds<br>• 30 seconds<br>• Multiples of 60 (60, 120, 180, etc.) | `300` (5 minutes) |
| **Datapoints to Alarm** | Number of breaching data points required to trigger alarm | Any positive integer                                                   | `2`               |
| **Number of Periods**   | Total evaluation periods to consider                      | Any positive integer                                                   | `3`               |

- **Understanding Datapoints vs Periods**

| Scenario        | Period | Datapoints to Alarm | Number of Periods | Result                                                    |
|-----------------|--------|---------------------|-------------------|-----------------------------------------------------------|
| Quick Response  | 60s    | 1                   | 1                 | Alarm triggers after 1 breach in 1 minute                 |
| Sustained Issue | 300s   | 2                   | 3                 | Alarm triggers when 2 out of 3 five-minute periods breach |
| Highly Tolerant | 60s    | 5                   | 10                | Alarm triggers when 5 out of 10 one-minute periods breach |

#### Statistic:

**Note**: AWS has limitations on the acceptable characters for the statistic value. you cannot use spaces, '%', or '(/)'.
All stats must be the statistic followed by a number or two numbers separated by a colon. For example, `p95` or `TM2:98`.

You can use the following statistics for alarms - https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html.

| Statistic              | Tag Value                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|------------------------|--------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **SampleCount**        | `SampleCount`                  | The number of data points during the period                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Sum**                | `Sum`                          | The sum of the values of all data points collected during the period                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Average**            | `Average`                      | The value of Sum/SampleCount during the specified period                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Minimum**            | `Minimum`                      | The lowest value observed during the specified period                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Maximum**            | `Maximum`                      | The highest value observed during the specified period                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Percentile**         | `p95`, `p99`, `p99.5`          | Indicates the relative standing of a value in a dataset. For example, p95 is the 95th percentile and means that 95 percent of the data within the period is lower than this value, and 5 percent of the data is higher than this value. Percentiles help you get a better understanding of the distribution of your metric data                                                                                                                                                                                                                                                                                                                                                                            |
| **Trimmed Mean**       | `tm90`, `TM2:98`, `TM150:1000` | The mean of all values that are between two specified boundaries. Values outside the boundaries are ignored when the mean is calculated. You define the boundaries as one or two numbers between 0 and 100, up to 10 decimal places. The numbers can be absolute values or percentages. For example, tm90 calculates the average after removing the 10% of data points with the highest values. TM(2%:98%) calculates the average after removing the 2% lowest data points and the 2% highest data points. TM(150:1000) calculates the average after removing all data points that are lower than or equal to 150, or higher than 1000                                                                     |
| **Interquartile Mean** | `IQM`                          | The trimmed mean of the interquartile range, or the middle 50% of values. It is equivalent to TM(25%:75%)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Winsorized Mean**    | `wm98`, `WM10:90`              | Similar to trimmed mean. However, with winsorized mean, the values that are outside the boundary are not ignored, but instead are considered to be equal to the value at the edge of the appropriate boundary. After this normalization, the average is calculated. You define the boundaries as one or two numbers between 0 and 100, up to 10 decimal places. For example, wm98 calculates the average while treating the 2% of the highest values to be equal to the value at the 98th percentile. WM(10%:90%) calculates the average while treating the highest 10% of data points to be the value of the 90% boundary, and treating the lowest 10% of data points to be the value of the 10% boundary |
| **Percentile Rank**    | `PR:300`, `PR100:2000`         | The percentage of values that meet a fixed threshold. For example, PR(:300) returns the percentage of data points that have a value of 300 or less. PR(100:2000) returns the percentage of data points that have a value between 100 and 2000. Percentile rank is exclusive on the lower bound and inclusive on the upper bound                                                                                                                                                                                                                                                                                                                                                                            |
| **Trimmed Count**      | `tc90`, `TC0.005:0.030`        | The number of data points in the chosen range for a trimmed mean statistic. For example, tc90 returns the number of data points not including any data points that fall in the highest 10% of the values. TC(0.005:0.030) returns the number of data points with values between 0.005 (exclusive) and 0.030 (inclusive)                                                                                                                                                                                                                                                                                                                                                                                    |
| **Trimmed Sum**        | `ts90`, `TS80:`                | The sum of the values of data points in a chosen range for a trimmed mean statistic. It is equivalent to (Trimmed Mean) × (Trimmed count). For example, ts90 returns the sum of the data points not including any data points that fall in the highest 10% of the values. TS(80%:) returns the sum of the data point values, not including any data points with values in the lowest 80% of the range of values                                                                                                                                                                                                                                                                                            |

#### Missing Data Treatment

| Tag Value      | Behavior                       |
|----------------|--------------------------------|
| `missing`      | Data point is missing          |
| `ignore`       | Current alarm state maintained |
| `breaching`    | Treated as threshold breach    |
| `notBreaching` | Treated as within threshold    |

#### Valid Comparison Operators

| Alarm Type | Comparison Operator | Description |
|------------|-------------------|-------------|
| **Static Threshold** | `GreaterThanOrEqualToThreshold` | Alarm when metric ≥ threshold |
| **Static Threshold** | `GreaterThanThreshold` | Alarm when metric > threshold |
| **Static Threshold** | `LessThanThreshold` | Alarm when metric < threshold |
| **Static Threshold** | `LessThanOrEqualToThreshold` | Alarm when metric ≤ threshold |
| **Anomaly Detection** | `GreaterThanUpperThreshold` | Alarm when metric exceeds upper band |
| **Anomaly Detection** | `LessThanLowerOrGreaterThanUpperThreshold` | Alarm when metric is outside the band (either direction) |
| **Anomaly Detection** | `LessThanLowerThreshold` | Alarm when metric falls below lower band |

## ReAlarm Tag Configuration and Behavior:

### Overview

The ReAlarm function is an AWS Lambda-based handler designed to monitor and reset CloudWatch alarms that are in an
"ALARM" state. It is an optional part of the AutoAlarm system, aimed at ensuring alarms are not missed or ignored.

### Default Values

By default, the ReAlarm function is enabled. When ReAlarm is enabled, it runs on a default schedule of every 120 minutes.

### Configure ReAlarm Behavior with Tags

ReAlarm's behavior can be configured on a per-alarm basis using tags.

- **Customize ReAlarm Schedule**:
    - The ReAlarm schedule by default runs every 120 minutes.
    - ReAlarm can be customized to run at different intervals on a per-alarm basis by setting the `autoalarm:re-alarm-minutes`
      tag to a whole number value.
- **Disable ReAlarm for a Resource**:
    - Alarms can be tagged with `autoalarm:re-alarm-enabled=false` to exclude them from the ReAlarm process.
    - When this tag is present on an alarm, ReAlarm will skip resetting it, regardless of its state.
    - This is useful for alarms that should be managed manually or have specific conditions that should not trigger ReAlarm.

#### Tag to Customize ReAlarm: 

| Tag                          | Value             | Description                     |
|------------------------------|-------------------|---------------------------------|
| `autoalarm:re-alarm-enabled` | `false`           | Disable ReAlarm for this alarm  |
| `autoalarm:re-alarm-minutes` | `30`, `60`, `240` | Custom reset interval (minutes) |

#### Special Note:

ReAlarm is hardcoded to NOT reset alarms associated with AutoScaling actions. This is to prevent the function from
interfering with scaling operations.

## Additional References:
- For a more thorough breakdown of Design and Architecture, please see ARCHITECTURE.md.
