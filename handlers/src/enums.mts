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
  'alb' = 'arn:aws:elasticloadbalancing:',
  'cloudfront' = 'arn:aws:cloudfront:', // can only be seen from us-east-1
  'ec2' = 'arn:aws:ec2:',
  'opensearch' = 'arn:aws:es:', // for open search clusters only and need additional filtering to make sure it has 'domain' in the ARN
  'rds' = 'arn:aws:rds:',
  'rds-cluster' = 'arn:aws:rds:cluster:',
  'route53-resolver' = 'arn:aws:route53resolver:',
  'sqs' = 'arn:aws:sqs:',
  'step-function' = 'arn:aws:states:',
  'targetgroup' = 'arn:aws:elasticloadbalancing:targetgroup:',
  'transit-gateway' = 'arn:aws:ec2:transit-gateway:',
  'vpn' = 'arn:aws:ec2:vpn:',
}
