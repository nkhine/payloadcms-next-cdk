import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export default class TaggingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    Tags.of(this).add('Application', 'payloadcms-next-cdk');
    Tags.of(this).add('BusinessUnit', 'DevOps');
    Tags.of(this).add(
      'Description',
      'This repo contains infrastructure code for the CMS.'
    );
    Tags.of(this).add('TechnicalOwner', 'norman@khine.net');
    Tags.of(this).add('ManagedBy', 'Infra');
    Tags.of(this).add('Tier', 'CMS');
  }
}
