import { NestedStack, NestedStackProps } from 'aws-cdk-lib';
import { IVpc, Peer, Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import {
  CfnReplicationGroup,
  CfnSubnetGroup,
} from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';
import { RedisConfig } from './config';

export interface RedisStackProps extends NestedStackProps {
  readonly vpc: IVpc;
  readonly redis: RedisConfig;
}

export class RedisStack extends NestedStack {
  redisCache: CfnReplicationGroup;

  constructor(scope: Construct, id: string, props: RedisStackProps) {
    super(scope, id);

    const redisSubnetGroup = new CfnSubnetGroup(
      this,
      'RedisCacheSubnetGroup',
      {
        cacheSubnetGroupName: 'private',
        description: 'Redis cache subnet',
        subnetIds: props.vpc.privateSubnets.map((subnet) => subnet.subnetId),
      },
    );

    const redisSecurityGroup = new SecurityGroup(this, 'Redis', {
      vpc: props.vpc,
    });

    redisSecurityGroup.addIngressRule(
      Peer.ipv4(props.vpc.vpcCidrBlock),
      Port.tcp(6379),
      'Allow incoming traffic from vpc on 6379/tcp',
    );

    this.redisCache = new CfnReplicationGroup(this, 'RedisCache', {
      ...props.redis,
      // Put remaining settings _below_ this
      automaticFailoverEnabled: true,
      replicationGroupDescription: 'Redis cache cluster',
      cacheSubnetGroupName: redisSubnetGroup.ref,
      securityGroupIds: [redisSecurityGroup.securityGroupId],
    });

    // Apple UseOnlineSharding Update Policy
    // See the notes here, https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-updatepolicy.html#cfn-attributes-updatepolicy-useonlineresharding
    this.redisCache.cfnOptions.updatePolicy = {
      useOnlineResharding: true,
    };
  }
}
