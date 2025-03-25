export enum ValidInstanceState {
  Running = 'running',
  //Pending = 'pending', //this doesn't work because a pending instance cant report stats... duh. Let's remove it... later
  //Stopped = 'stopped', //will be removed. For testing only.
  //Stopping = 'stopping', //will be removed. For testing only.
  //ShuttingDown = 'shutting-down', //will be removed. For testing only.
  Terminated = 'terminated',
}
export enum AlarmClassification {
  Critical = 'Critical',
  Warning = 'Warning',
}

export enum AlarmManagerEnumberation {
   'alb'= 'arn:aws:elasticloadbalancing:',
   'cloudfront'= 'arn:aws:cloudfront:', // can only be seen from us-east-1
   'ec2'= 'arn:aws:ec2:',
   'opensearch'= 'arn:aws:es', // for open search clusters only and need additional filtering to make sure it has 'domain' in teh ARN
   'rds'= 'test',
   'rds-cluster'= 'arn:place:holder1',
   'route53-resolver'= 'arn:place:holder',
   'sqs'= 'arn:place:holder2',
   'step-function'= 'arn:place:holder3',
   'targetgroup'= 'arn:place:holder4',
   'transit-gateway'= 'arn:place:holder5',
   'vpn'= 'arn:place:holder6'
}
