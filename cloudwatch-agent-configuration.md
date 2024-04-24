# Installing and Configuring AWS CloudWatch Agent Using AWS SSM

This guide provides step-by-step instructions on how to install and configure the AWS CloudWatch Agent on EC2 instances using AWS Systems Manager (SSM). This method allows for easy deployment and management of the CloudWatch Agent across multiple instances without the need for manual SSH access to each instance.

## Prerequisites

- **AWS Account**: Ensure you have an AWS account.
- **EC2 Instance(s)**: Running Amazon Linux 2 or other supported OS.
- **IAM Role**: An IAM role for EC2 with permissions to access Systems Manager and CloudWatch.
- **AWS CLI**: Optionally, the AWS CLI installed on your local machine for running commands.

## Step 1: Attach IAM Role to EC2 Instances

Ensure that your EC2 instances have an IAM role with the necessary permissions to interact with Systems Manager and CloudWatch. Create a role with the `AmazonSSMManagedInstanceCore` and `CloudWatchAgentServerPolicy` policies attached.

1. Go to the IAM Management Console.
2. Create a new role and select AWS service -> EC2.
3. Attach the `AmazonSSMManagedInstanceCore` and `CloudWatchAgentServerPolicy` policies.
4. The action `ssm:PutParameter` is required for the CloudWatch Agent to store configuration parameters.
5. Attach this role to your EC2 instances.

## Step 2: Install the SSM Agent

AWS Systems Manager Agent (SSM Agent) is installed by default on Amazon Linux 2 AMIs and some other supported AMIs. If your instance does not have SSM Agent installed, follow the [official guide](https://docs.aws.amazon.com/systems-manager/latest/userguide/ssm-agent.html) to install it.

## Step 3: Install the CloudWatch Agent

Use SSM to run commands on your EC2 instances to install the CloudWatch Agent.

### Using AWS Management Console

1. Open the AWS Systems Manager console.
2. In the navigation pane, choose **Run Command**.
3. Choose **Run command**.
4. In the **Command document** list, choose `AWS-ConfigureAWSPackage`.
5. In the **Targets** area, select the instances where you want to install the agent.
6. In the **Action** options, select **Install**.
7. For **Name**, type `AmazonCloudWatchAgent`.
8. Uncheck `Enable an S3 bucket` in Output options.
9. Click on **Run**.

## Step 4: Configure the CloudWatch Agent

Use the wizard to configure the CloudWatch Agent on your EC2 instances. The wizard will guide you through setting up the agent and creating a configuration file. You can save this configuration to an SSM parameter for easy management.

Once the configuration is saved, you can apply it to multiple instances using SSM.

### Linux Configuration Wizard

1. SSH into your EC2 instance.
2. Run the following command to start the configuration wizard:
    ```sh
    sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard
3. Follow the prompts to configure the agent.
4. Save the configuration to an SSM parameter.

### Windows Configuration Wizard

1. RDP into your Windows EC2 instance.
2. Run the following command to start the configuration wizard:
   ```sh
   cd "C:\Program Files\Amazon\AmazonCloudWatchAgent"
   ```
   ```sh
   .\amazon-cloudwatch-agent-config-wizard.exe
3. Follow the prompts to configure the agent.
4. Save the configuration to an SSM parameter.

## Step 5: Apply the Configuration Using SSM

### Using AWS Management Console

1. Go back to the AWS Systems Manager console.
2. Navigate to **Run Command**.
3. Choose `AmazonCloudWatch-ManageAgent`.
4. Specify the action as **configure**.
5. Set the mode to **ec2**.
6. In the **optionalConfigurationSource** choose **ssm**.
7. Specify the **optionalConfigurationLocation** with the name of the SSM parameter where your configuration is saved.
8. Uncheck `Enable an S3 bucket` in Output options.
9. Select your targets and run the command.

