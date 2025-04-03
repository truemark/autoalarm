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

// map services to matching patterns for event parsing see line 126 in processor-factory.mts and processor classes
export enum EventPatterns {
  'alb' = 'arn:aws:elasticloadbalancing:',
  'cloudfront' = 'arn:aws:cloudfront:', // can only be seen from us-east-1
  'ec2' = 'arn:aws:ec2:',
  'opensearch' = 'arn:aws:es:', // for open search clusters only and need additional filtering to make sure it has 'domain' in the ARN
  'rds' = 'arn:aws:rds:',
  'rdscluster' = 'arn:aws:rds:cluster:',
  'route53resolver' = 'arn:aws:route53resolver:',
  'sqs' = 'arn:aws:sqs:',
  'sfn' = 'arn:aws:states:',
  'targetgroup' = 'arn:aws:elasticloadbalancing:targetgroup:',
  'transitgateway' = 'arn:aws:ec2:transit-gateway:',
  'vpn' = 'arn:aws:ec2:vpn:',
}
