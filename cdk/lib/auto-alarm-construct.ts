import {Construct} from 'constructs';
import {MainFunction} from './main-function';
import {StandardQueue} from 'truemark-cdk-lib/aws-sqs';
import {Rule} from 'aws-cdk-lib/aws-events';
import {LambdaFunction} from 'aws-cdk-lib/aws-events-targets';
import {PolicyStatement, Effect} from 'aws-cdk-lib/aws-iam';

export class AutoAlarmConstruct extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const mainFunction = new MainFunction(this, 'MainFunction');
    const deadLetterQueue = new StandardQueue(this, 'DeadLetterQueue');
    const mainTarget = new LambdaFunction(mainFunction, {
      deadLetterQueue,
    });

    // Add permissions to the Lambda function's role
    mainFunction.role?.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'ec2:DescribeTags',
          'cloudwatch:PutMetricAlarm', // Include other necessary actions here
          'cloudwatch:DeleteAlarms',
        ],
        resources: ['*'], // Adjust as necessary to limit permissions
      })
    );

    // Listen to tag changes related to AutoAlarm
    const tagRule = new Rule(this, 'TagRule', {
      eventPattern: {
        source: ['aws.tag'],
        detailType: ['Tag Change on Resource'],
        detail: {
          service: ['ec2', 'ecs', 'rds'],
          'resource-type': ['instance'],
          'changed-tag-keys': ['autoalarm:disabled'],
        },
      },
      description: 'Routes tag events to AutoAlarm',
    });
    tagRule.addTarget(mainTarget);

    const ec2Rule = new Rule(this, 'Ec2Rule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: {
          state: ['running', 'terminated'],
        },
      },
      description: 'Routes ec2 instance events to AutoAlarm',
    });
    ec2Rule.addTarget(mainTarget);
  }
}
