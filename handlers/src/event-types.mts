// eventsType.mts

export type OSEvent = {
  'detail-type': string;
  'resources': string[];
  'detail': {
    'tags': Record<string, string>;
    'changed-tag-keys': string[];
    'eventName': string;
    'responseElements': {
      domain: {
        arn: string;
      };
    };
    'requestParameters': {
      domainArn: string;
    };
    'requestID': string;
  } & Record<string, unknown>;
} & Record<string, unknown>;

export type SQSEvent = {
  'detail-type': string;
  'resources': string[];
  'detail': {
    'tags': Record<string, string>;
    'changed-tag-keys': string[];
    'eventName': string;
    'responseElements': {
      queueUrl: string;
    };
    'requestParameters': {
      queueUrl: string;
      tags: Record<string, string>;
    };
    'requestID': string;
  };
} & Record<string, unknown>;

export type TGEvent = {
  'detail-type': string;
  'resources': string[];
  'detail': {
    'tags': Record<string, string>;
    'changed-tag-keys': string[];
    'eventName': string;
    'responseElements': {
      targetGroups: Array<{
        targetGroupArn: string;
      }>;
    };
    'requestParameters': {
      targetGroupArn: string;
    };
    'requestID': string;
  };
} & Record<string, unknown>;

export type ALBEvent = {
  'detail-type': string;
  'resources': string[];
  'detail': {
    'tags': Record<string, string>;
    'changed-tag-keys': string[];
    'eventName': string;
    'responseElements': {
      loadBalancers: Array<{
        loadBalancerArn: string;
      }>;
    };
    'requestParameters': {
      loadBalancerArn: string;
    };
    'requestID': string;
  };
} & Record<string, unknown>;
