#!/bin/bash

# Update the instance
sudo apt-get update -y
sudo apt-get upgrade -y

# Install the CloudWatch Agent
sudo apt-get install -y amazon-cloudwatch-agent

# Check if the configuration directory exists, create if it doesn't
sudo mkdir -p /opt/aws/amazon-cloudwatch-agent/etc/

# Create the CloudWatch Agent configuration file
cat <<EOT | sudo tee /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
{
    "agent": {
        "metrics_collection_interval": 60,
        "run_as_user": "cwagent"
    },
    "metrics": {
        "append_dimensions": {
            "AutoScalingGroupName": "${aws:AutoScalingGroupName}",
            "ImageId": "${aws:ImageId}",
            "InstanceId": "${aws:InstanceId}",
            "InstanceType": "${aws:InstanceType}"
        },
        "aggregation_dimensions" : [["InstanceId","path"]],
        "metrics_collected": {
            "disk": {
                "measurement": [
                    "used_percent"
                ],
                "metrics_collection_interval": 60,
                "resources": [
                    "*"
                ],
                "ignore_file_system_types": [
                    "sysfs", "devtmpfs", "tmpfs", "overlay", "debugfs", "squashfs", "iso9660", "proc", "autofs", "tracefs"
                ],
                "drop_device": true
            },
            "mem": {
                "measurement": [
                    "mem_used_percent"
                ],
                "metrics_collection_interval": 60
            }
        }
    }
}
EOT

# Set permissions for the CloudWatch Agent config file
sudo chmod 640 /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
sudo chown cwagent:cwagent /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

# Start the CloudWatch Agent using the new configuration
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
    -a fetch-config \
    -m ec2 \
    -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json \
    -s

sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a start
