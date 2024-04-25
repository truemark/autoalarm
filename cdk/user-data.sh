#!/bin/bash

# Update the instance
sudo yum update -y

# Install the CloudWatch Agent
sudo yum install -y amazon-cloudwatch-agent

# Check if the configuration directory exists, create if it doesn't
sudo mkdir -p /opt/aws/amazon-cloudwatch-agent/etc/

# Create the CloudWatch Agent configuration file
cat <<EOT | sudo tee /opt/aws/amazon-cloudwatch-agent/bin/config.json
{
        "agent": {
                "metrics_collection_interval": 60,
                "run_as_user": "cwagent"
        },
        "metrics": {
                "aggregation_dimensions": [
                        [
                                "InstanceId"
                        ]
                ],
                "append_dimensions": {
                        "AutoScalingGroupName": "${aws:AutoScalingGroupName}",
                        "ImageId": "${aws:ImageId}",
                        "InstanceId": "${aws:InstanceId}",
                        "InstanceType": "${aws:InstanceType}"
                },
                "metrics_collected": {
                        "disk": {
                                "measurement": [
                                        "used_percent"
                                ],
                                "metrics_collection_interval": 60,
                                "resources": [
                                        "*"
                                ]
                        },
                        "mem": {
                                "measurement": [
                                        "mem_used_percent"
                                ],
                                "metrics_collection_interval": 60
                        },
                        "statsd": {
                                "metrics_aggregation_interval": 60,
                                "metrics_collection_interval": 10,
                                "service_address": ":8125"
                        }
                }
        }
}

EOT

# Set permissions for the CloudWatch Agent config file
sudo chmod 640 /opt/aws/amazon-cloudwatch-agent/bin/config.json
sudo chown cwagent:cwagent /opt/aws/amazon-cloudwatch-agent/bin/config.json

# Start the CloudWatch Agent using the new configuration
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
    -a fetch-config \
    -m ec2 \
    -c file:/opt/aws/amazon-cloudwatch-agent/bin/config.json \
    -s

sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a start
