import { RemovalPolicy, StackProps } from 'aws-cdk-lib';
import { IVpc } from 'aws-cdk-lib/aws-ec2';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { CfnDeliveryStream } from 'aws-cdk-lib/aws-kinesisfirehose';
// import { Stream, StreamMode } from 'aws-cdk-lib/aws-kinesis';
import {
  // Effect,
  AccountPrincipal,
  PolicyStatement,
  ServicePrincipal,
  Role,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AppPipelineStack } from './apps/pipeline';
import { AppStack } from './apps/stack';
import { App, AccountConfig } from './config';
import TaggingStack from './tagging';

interface CmsAppsWrapperStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly fileSystemId: string;
  readonly apps: {
    [name: string]: App;
  };
  readonly environment: string;
  readonly ApiLogBucketArn: string; // Add ApiLogBucketArn field
  readonly accounts: AccountConfig[];
}

export class CmsAppsWrapperStack extends TaggingStack {
  constructor(scope: Construct, id: string, props: CmsAppsWrapperStackProps) {
    super(scope, id, props);

    const bucket = new Bucket(this, 'AppsBucket', {
      bucketName: `payloadcms-${this.account}-${this.region}`,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Add a policy statement for each account
    props.accounts.forEach((account) => {
      const principal = new AccountPrincipal(account.id);

      // Statement for object-level permissions
      bucket.addToResourcePolicy(
        new PolicyStatement({
          sid: `AllowObjectAccessForAccount${account.id}`,
          principals: [principal],
          actions: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
          resources: [bucket.arnForObjects('*')],
        })
      );

      // Separate statement for bucket-level permissions
      bucket.addToResourcePolicy(
        new PolicyStatement({
          sid: `AllowBucketAccessForAccount${account.id}`,
          principals: [principal],
          actions: ['s3:ListBucket'],
          resources: [bucket.bucketArn],
        })
      );
    });
    const artifactsBucket = new Bucket(this, 'ArtifactsBucket', {
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // High-level bucket constructs for versioning
    const firehoseBucket = new Bucket(this, 'ApiLogsBucket', {
      bucketName: `api-logs-${this.account}-${this.region}`,
      removalPolicy: RemovalPolicy.DESTROY,
      versioned: true,
    });
    const firehoseRole = new Role(this, 'FirehoseRole', {
      assumedBy: new ServicePrincipal('firehose.amazonaws.com'),
    });

    firehoseRole.addToPolicy(
      new PolicyStatement({
        actions: [
          's3:AbortMultipartUpload',
          's3:GetBucketLocation',
          's3:GetObject',
          's3:ListBucket',
          's3:ListBucketMultipartUploads',
          's3:PutObject',
        ],
        resources: [
          firehoseBucket.bucketArn,
          firehoseBucket.arnForObjects('*'),
          // 'arn:aws:s3:::apigateway-logs-1234567890-eu-west-1',
        ],
      })
    );
    // Low-level construct CfnBucket to setup replication
    // const cfnFirehoseBucket = firehoseBucket.node.defaultChild as CfnBucket;
    // cfnFirehoseBucket.replicationConfiguration = {
    //   role: firehoseRole.roleArn, // The ARN of the IAM role that Amazon S3 assumes when replicating objects
    //   rules: [
    //     {
    //       id: 'ReplicateToApiLogsBucket', // A unique identifier for the rule
    //       status: 'Enabled', // The rule is enabled
    //       destination: {
    //         bucket: 'arn:aws:s3:::apigateway-logs-1234567890-eu-west-1', //props.ApiLogBucketArn, // Destination bucket ARN
    //         storageClass: 'STANDARD', // The storage class to use when replicating objects
    //       },
    //       prefix: '', // An object keyname prefix that identifies the object or objects to apply the rule to
    //     },
    //   ],
    // };

    const firehoseStream = new CfnDeliveryStream(this, 'SharedDeliveryStream', {
      deliveryStreamType: 'DirectPut',
      extendedS3DestinationConfiguration: {
        bucketArn: firehoseBucket.bucketArn,
        bufferingHints: {
          intervalInSeconds: 60,
          sizeInMBs: 50,
        },
        compressionFormat: 'GZIP',
        roleArn: firehoseRole.roleArn,
        prefix: `firehose/`,
      },
    });

    // Deploy all the apps!
    for (let name in props.apps) {
      let values = props.apps[name];

      const appStack = new AppStack(this, `App-${name}`, {
        vpc: props.vpc,
        certificate: values.certificate,
        cms: values.cms,
        domain: values.domain,
        name: name,
        repo: values.repo,
        appEnv: values.appEnv,
        fileSystemId: props.fileSystemId,
        buildEnv: {},
        bucket: bucket,
        firehoseStream: firehoseStream,
      });

      new AppPipelineStack(this, `AppPipeline-${name}`, {
        vpc: props.vpc,
        repo: values.repo,
        ecr: appStack.ecr,
        name: name,
        releaseParameters: {
          releaseArn: appStack.releaseArn,
          releaseName: appStack.releaseName,
          releaseTag: appStack.releaseTag,
          packageVersion: appStack.packageVersion,
        },
        buildEnv: values.buildEnv,
        updaterLambda: appStack.updaterLambda,
        artifactsBucket: artifactsBucket,
        environment: props.environment,
      });
    }
  }
}
