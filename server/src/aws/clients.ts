import { EC2Client } from '@aws-sdk/client-ec2';
import { ECRClient } from '@aws-sdk/client-ecr';
import { SSMClient } from '@aws-sdk/client-ssm';
import { IAMClient } from '@aws-sdk/client-iam';
import { fromIni } from '@aws-sdk/credential-providers';

export interface AwsClients {
  ec2: EC2Client;
  ecr: ECRClient;
  ssm: SSMClient;
  iam: IAMClient;
}

const cache = new Map<string, AwsClients>();

// AWS_PROFILE selects a named profile; otherwise the SDK default chain applies.
export function clients(region: string): AwsClients {
  let c = cache.get(region);
  if (!c) {
    const credentials = process.env.AWS_PROFILE ? fromIni({ profile: process.env.AWS_PROFILE }) : undefined;
    const cfg = { region, credentials };
    c = { ec2: new EC2Client(cfg), ecr: new ECRClient(cfg), ssm: new SSMClient(cfg), iam: new IAMClient(cfg) };
    cache.set(region, c);
  }
  return c;
}

export function resetClients(): void {
  cache.clear();
}
