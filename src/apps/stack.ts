import path from 'path';
import {
  Duration,
  NestedStack,
  NestedStackProps,
  PhysicalName,
  RemovalPolicy,
} from 'aws-cdk-lib';

import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { IVpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import { AccessPoint, FileSystem } from 'aws-cdk-lib/aws-efs';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import {
  MethodLoggingLevel,
  RestApi,
  LambdaIntegration,
} from 'aws-cdk-lib/aws-apigateway';
import {
  Code,
  Function,
  Handler,
  IFunction,
  Runtime,
  FileSystem as LambdaFileSystem,
} from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { CfnDeliveryStream } from 'aws-cdk-lib/aws-kinesisfirehose';

// import { Stream } from 'aws-cdk-lib/aws-kinesis';

// import { KinesisDestination } from 'aws-cdk-lib/aws-logs-destinations';
import { Construct } from 'constructs';
import { App } from '../config';
// import { getLogRetentionPeriod } from '../helper';

interface AppStackProps extends NestedStackProps, App {
  readonly name: string;
  readonly vpc: IVpc;
  readonly fileSystemId: string;
  readonly bucket: IBucket;
  readonly appEnv: {
    readonly [name: string]: string;
  };
  readonly firehoseStream: CfnDeliveryStream;
}

export class AppStack extends NestedStack {
  releaseArn: StringParameter;
  releaseName: StringParameter;
  releaseTag: StringParameter;
  packageVersion: StringParameter;
  ecr: Repository;
  updaterLambda: IFunction;
  // firehoseBucket: IBucket;
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    this.ecr = new Repository(this, 'AppsECR', {
      removalPolicy: RemovalPolicy.DESTROY,
      imageScanOnPush: true,
    });

    this.ecr.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowLambdaToPullImages',
        effect: Effect.ALLOW,
        principals: [new ServicePrincipal('lambda.amazonaws.com')],
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
      })
    );

    const bootstrapAsset = new DockerImageAsset(this, 'BootstrapAsset', {
      directory: path.join(__dirname, '..', 'lambda', 'placeholder'),
    });

    this.releaseArn = new StringParameter(this, 'ReleaseRepoArn', {
      parameterName: `/cms/${props.name}/repository-arn`,
      // This is used for the first deployment
      // This parameter will be updated by the pipeline stack after successfully pushing a new image
      stringValue: bootstrapAsset.repository.repositoryArn,
    });
    this.releaseName = new StringParameter(this, 'ReleaseRepoName', {
      parameterName: `/cms/${props.name}/repository-name`,
      stringValue: bootstrapAsset.repository.repositoryName,
    });
    this.releaseTag = new StringParameter(this, 'ReleaseImageTag', {
      parameterName: `/cms/${props.name}/release-tag`,
      stringValue: bootstrapAsset.imageTag,
    });
    this.packageVersion = new StringParameter(this, 'PackageVersion', {
      parameterName: `/cms/${props.name}/package-version`,
      stringValue: 'version',
    });

    const efs = FileSystem.fromFileSystemAttributes(this, 'Efs', {
      fileSystemId: props.fileSystemId,
      securityGroup: new SecurityGroup(this, 'EfsLambdaGroup', {
        vpc: props.vpc,
      }),
    });

    const accessPoint = new AccessPoint(this, 'LambdaAccessPoint', {
      fileSystem: efs,
      createAcl: {
        ownerGid: '1001',
        ownerUid: '1001',
        permissions: '750',
      },
      path: '/export/lambda',
      posixUser: {
        uid: '1001',
        gid: '1001',
      },
    });

    const handler = new Function(this, 'AppLambda', {
      runtime: Runtime.FROM_IMAGE,
      handler: Handler.FROM_IMAGE,
      timeout: Duration.minutes(15),
      memorySize: 8096,
      vpc: props.vpc,
      functionName: PhysicalName.GENERATE_IF_NEEDED,
      logRetention: RetentionDays.ONE_DAY,
      code: Code.fromEcrImage(
        Repository.fromRepositoryAttributes(this, 'Ecr', {
          repositoryArn: this.releaseArn.stringValue,
          repositoryName: this.releaseName.stringValue,
        }),
        {
          tagOrDigest: this.releaseTag.stringValue,
        }
      ),
      description: `lambda function hosting cms/${props.name}`,
      environment: {
        // any environment variables needed by your upload function
        IMAGE_TAG_PARAMETER_NAME: this.releaseTag.parameterName,
        VERSION_PARAMETER_NAME: this.packageVersion.parameterName,
        REGION: this.region,
        S3_BUCKET_NAME: props.bucket.bucketName,
        // NEXT_PUBLIC_IMAGE_DOMAINS: props.bucket.bucketRegionalDomainName,
      },
      filesystem: LambdaFileSystem.fromEfsAccessPoint(accessPoint, '/mnt/efs'),
    });
    // Give the handler Apps lambda access to the S3 bucket
    props.bucket.grantReadWrite(handler);

    handler.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        resources: [this.ecr.repositoryArn],
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
      })
    );

    efs.connections.allowDefaultPortFrom(handler.connections);
    props.bucket.grantReadWrite(handler);
    handler.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ecr:SetRepositoryPolicy', 'ecr:GetRepositoryPolicy'],
        resources: [this.ecr.repositoryArn],
      })
    );

    if (props.appEnv != null) {
      for (let key in props.appEnv) {
        handler.addEnvironment(key, props.appEnv[key]);
      }
    }

    const api = new RestApi(this, 'Api', {
      restApiName: `api-cms-${props.name}`,
      description: `api gateway for cms/${props.name}`,
      // ...
      deployOptions: {
        methodOptions: {
          '/*/*': {
            // to apply these settings to all resources and methods
            loggingLevel: MethodLoggingLevel.INFO,
            dataTraceEnabled: true,
          },
        },
      },
      // ...
      domainName: {
        certificate: Certificate.fromCertificateArn(
          this,
          'ApiGwCertificate',
          props.certificate
        ),
        domainName: props.domain,
      },
      binaryMediaTypes: [
        'application/*',
        'image/*',
        'audio/*',
        'video/*',
        'multipart/form-data'
      ],
      defaultIntegration: new LambdaIntegration(handler),
    });
    // const logGroup = new LogGroup(this, 'ApiLogGroup', {
    //   removalPolicy: RemovalPolicy.DESTROY, // adjust to your needs
    // });

    // const destination = new LogGroupLogDestination(logGroup);
    // const stage = api.deploymentStage;
    // stage.node.tryRemoveChild('AccessLogSetting');
    // new CfnStage(this, 'CfnStage', {
    //   restApiId: api.restApiId,
    //   stageName: stage.stageName,
    //   accessLogSetting: {
    //     destinationArn: destination.bind(stage).destinationArn,
    //     format: AccessLogFormat.jsonWithStandardFields({
    //       caller: true,
    //       httpMethod: true,
    //       ip: true,
    //       protocol: true,
    //       requestTime: true,
    //       resourcePath: true,
    //       responseLength: true,
    //       status: true,
    //       user: true,
    //     }).toString(),
    //   },
    // });
    // const firehoseStream = props.firehoseStream;
    // const kinesisStream = firehoseStream.attrArn;
    // const kinesisDestination = new KinesisDestination(kinesisStream);
    // // const kinesisDestination = new KinesisDestination(firehoseStream);
    // if (logGroup != null) {
    //   logGroup.addSubscriptionFilter(`kinesis-subscription`, {
    //     destination: kinesisDestination,
    //     filterPattern: FilterPattern.allEvents(),
    //   });
    // }

    api.root.addProxy({
      defaultIntegration: new LambdaIntegration(handler),
    });

    const versionFunction = new Function(this, 'versionFunction', {
      runtime: Runtime.GO_1_X,
      timeout: Duration.minutes(5),
      memorySize: 1024,
      logRetention: RetentionDays.ONE_DAY,
      functionName: PhysicalName.GENERATE_IF_NEEDED,
      handler: 'dist/lambda/version',
      code: Code.fromAsset(
        path.join(__dirname, '..', '..', 'dist', 'version.zip')
      ),
      description: 'Version lambda function',
      environment: {
        IMAGE_TAG_PARAMETER_NAME: this.releaseTag.parameterName,
        VERSION_PARAMETER_NAME: this.packageVersion.parameterName,
        REGION: this.region,
      },
    });
    const versionResource = api.root.addResource('version');
    versionResource.addMethod('GET', new LambdaIntegration(versionFunction));
    versionFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${this.releaseTag.parameterName}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${this.packageVersion.parameterName}`,
        ],
      })
    );

    // Updater function
    this.updaterLambda = new Function(this, 'UpdaterLambda', {
      runtime: Runtime.GO_1_X,
      handler: 'dist/lambda/updater',
      memorySize: 128,
      timeout: Duration.minutes(1),
      logRetention: RetentionDays.ONE_DAY,
      functionName: PhysicalName.GENERATE_IF_NEEDED,
      code: Code.fromAsset(
        path.join(__dirname, '..', '..', 'dist', 'updater.zip')
      ),
      description:
        'This lambda is responsible for deploying newly built images to a lambda function',
      environment: {
        FUNCTION_ARN: handler.functionArn,
        IMAGE_PARAMETER_NAME: this.releaseName.parameterName,
        IMAGE_TAG_PARAMETER_NAME: this.releaseTag.parameterName,
        REGION: this.region,
      },
    });
    this.updaterLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        resources: [handler.functionArn],
        actions: [
          'lambda:UpdateFunctionCode',
          'lambda:PublishVersion',
          'lambda:UpdateFunctionConfiguration',
        ],
      })
    );
    this.updaterLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        resources: [
          this.releaseName.parameterArn,
          this.releaseTag.parameterArn,
        ],
        actions: [
          'ssm:GetParameters',
          'ssm:GetParameter',
          'ssm:GetParameterHistory',
        ],
      })
    );
    this.updaterLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        resources: ['*'],
        actions: ['ssm:DescribeParameters'],
      })
    );
    this.updaterLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        resources: [this.ecr.repositoryArn],
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
      })
    );
    // Add routes
  }
}
