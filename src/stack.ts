import * as path from 'path';
import {
  CfnOutput,
  PhysicalName,
  RemovalPolicy,
  SecretValue,
  StackProps,
} from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import {
  BastionHostLinux,
  FlowLogDestination,
  FlowLogFileFormat,
  GatewayVpcEndpointAwsService,
  InstanceClass,
  InstanceSize,
  InstanceType,
  IpAddresses,
  ISecurityGroup,
  IVpc,
  NatProvider,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import {
  AwsLogDriver,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
  Secret as EcsSecret,
} from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import {
  AccessPoint,
  FileSystem,
  LifecyclePolicy,
  OutOfInfrequentAccessPolicy,
  PerformanceMode,
  ThroughputMode,
} from 'aws-cdk-lib/aws-efs';
import { ApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { PrivateDnsNamespace } from 'aws-cdk-lib/aws-servicediscovery';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { AlbConfig, AppEnvConfig, FargateConfig, VpcConfig } from './config';
import { RedisStack } from './redis-stack';
import TaggingStack from './tagging';

interface AppStackProps extends StackProps {
  readonly config: AppEnvConfig;
  readonly environment: string;
  readonly vpc: VpcConfig;
}

export class CmsStack extends TaggingStack {
  vpc: IVpc;
  vpcSecurityGroup: ISecurityGroup;
  ecr: Repository;
  fargateService!: FargateService; // Added ! to declare fargateService as non-nullable
  fargateAlb: ApplicationLoadBalancer;
  readonly releaseTag: StringParameter;
  readonly releaseName: StringParameter;
  readonly releaseArn: StringParameter;
  readonly cmsFileSystemId: string;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const flowLogBucket = Bucket.fromBucketArn(
      this,
      'FlowLogBucket',
      props.vpc.flowLogBucketArn
    );

    // VPC
    const vpc = new Vpc(this, 'InfraVPC', {
      ipAddresses: IpAddresses.cidr(props.vpc.cidr),
      enableDnsSupport: true,
      enableDnsHostnames: true,
      maxAzs: props.vpc.maxAzs,
      natGatewayProvider: NatProvider.instance({
        instanceType: InstanceType.of(InstanceClass.T2, InstanceSize.MICRO),
      }),
      gatewayEndpoints: {
        // Keep S3 <-> Apps traffic and
        // ECR <-> Apps traffic in the VPC to reduce data transfer costs
        S3: { service: GatewayVpcEndpointAwsService.S3 },
      },
      flowLogs: {
        FlowLogS3: {
          destination: FlowLogDestination.toS3(
            flowLogBucket,
            props.vpc.flowLogPrefix,
            {
              // perHourPartition: true,
              fileFormat: FlowLogFileFormat.PARQUET,
              hiveCompatiblePartitions: true,
            }
          ),
        },
      },
    });
    this.vpc = vpc;

    const redisPort = Port.tcp(6379);
    const documentDBPort = Port.tcp(27017);
    // Create VPC Security Group
    this.vpcSecurityGroup = new SecurityGroup(this, 'VpcSecurityGroup', {
      vpc: vpc,
    });

    // const sg = new SecurityGroup(this, 'docdb-lambda-sg', {
    //   vpc,
    //   securityGroupName: 'docdb-lambda-sg',
    // });
    // Allow local traffic
    this.vpcSecurityGroup.addIngressRule(
      Peer.ipv4(vpc.vpcCidrBlock),
      // Redis cache cluster uses 6379 port by default.
      redisPort
    );
    this.vpcSecurityGroup.addIngressRule(
      Peer.ipv4(vpc.vpcCidrBlock),
      // DocumentDB cluster uses 27017 port by default.
      documentDBPort
    );

    // EFS
    let CmsFileSystem = new FileSystem(this, 'Efs', {
      vpc: vpc,
      encrypted: true,
      lifecyclePolicy: LifecyclePolicy.AFTER_14_DAYS, // files are not transitioned to infrequent access (IA) storage by default
      performanceMode: PerformanceMode.GENERAL_PURPOSE, // default
      outOfInfrequentAccessPolicy: OutOfInfrequentAccessPolicy.AFTER_1_ACCESS, // files are not transitioned back from (infrequent access) IA to primary storage by default
      throughputMode: ThroughputMode.BURSTING,
    });
    this.cmsFileSystemId = CmsFileSystem.fileSystemId;
    CmsFileSystem.connections.allowDefaultPortFrom(
      Peer.ipv4(this.vpc.vpcCidrBlock),
      'Allow NFS traffic from anyone in the VPC'
    );
    let accessPoint = CmsFileSystem.addAccessPoint('AccessPoint', {
      createAcl: {
        ownerGid: '1001',
        ownerUid: '1001',
        permissions: '750',
      },
      path: '/export/lambda',
      posixUser: {
        gid: '1001',
        uid: '1001',
      },
    });

    const subnetGroup = new docdb.CfnDBSubnetGroup(this, 'subnet-group', {
      subnetIds: vpc.privateSubnets.map((x) => x.subnetId),
      dbSubnetGroupName: 'subnet-group',
      dbSubnetGroupDescription: 'Subnet Group for DocDB',
    });

    // Bastion host
    const bastionHostSG = new SecurityGroup(this, 'BastionSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      securityGroupName: 'bastion-sg',
    });

    const bastionHost = new BastionHostLinux(this, 'BastionHost', {
      vpc,
      securityGroup: bastionHostSG,
      subnetSelection: { subnetType: SubnetType.PUBLIC },
    });
    bastionHost.instance.instance.keyName = 'cms';
    // Password
    const databaseCredentialsSecret = new Secret(
      this,
      'DatabaseCredentialsSecret',
      {
        secretName: '/cms/documentdb/credentials',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            username: 'root',
          }),
          excludePunctuation: true,
          includeSpace: false,
          generateStringKey: 'password',
        },
      }
    );

    const dbClusterSecurityGroup = new SecurityGroup(
      this,
      'DatabaseClusterSecurityGroup',
      {
        vpc: vpc,
        allowAllOutbound: true,
      }
    );

    const dbCluster = new docdb.DatabaseCluster(this, 'db-cluster', {
      masterUser: {
        username: 'root',
        password: SecretValue.secretsManager(
          databaseCredentialsSecret.secretArn,
          { jsonField: 'password' }
        ),
      },
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC,
      },
      vpc,
      deletionProtection: false, // Enable deletion protection.
      exportAuditLogsToCloudWatch: true,
      exportProfilerLogsToCloudWatch: true,
      storageEncrypted: true,
      port: docdb.DatabaseCluster.DEFAULT_PORT,
      removalPolicy: RemovalPolicy.DESTROY,
      securityGroup: dbClusterSecurityGroup,
    });

    subnetGroup.node.addDependency(dbCluster);
    databaseCredentialsSecret.attach(dbCluster);

    new docdb.DatabaseInstance(this, 'MyDatabaseInstance', {
      cluster: dbCluster,
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),

      // the properties below are optional
      autoMinorVersionUpgrade: false,
      // availabilityZone: "availabilityZone",
      // dbInstanceName: "dbInstanceName",
      // preferredMaintenanceWindow: "preferredMaintenanceWindow",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Allow connections from bastion host to the database cluster
    dbCluster.connections.allowFrom(
      bastionHost.connections,
      Port.tcp(dbCluster.clusterEndpoint.port),
      'Bastion host connection'
    );
    // Allow connections from Fargate service to the database cluster
    dbCluster.connections.allowFromAnyIpv4(
      Port.tcp(dbCluster.clusterEndpoint.port),
      'Fargate service connection'
    );
    //
    this.ecr = new Repository(this, 'PayloadCmsECR', {
      removalPolicy: RemovalPolicy.DESTROY,
      repositoryName: PhysicalName.GENERATE_IF_NEEDED,
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
      directory: path.join(__dirname, 'lambda', 'placeholder'),
    });
    this.releaseArn = new StringParameter(this, 'ReleaseRepoArn', {
      parameterName: `/cms/${props.environment}/repository-arn`,
      // This is used for the first deployment
      // This parameter will be updated by the pipeline stack after successfully pushing a new image
      stringValue: bootstrapAsset.repository.repositoryArn,
    });
    this.releaseName = new StringParameter(this, 'ReleaseRepoName', {
      parameterName: `/cms/${props.environment}/repository-name`,
      stringValue: bootstrapAsset.repository.repositoryName,
    });
    this.releaseTag = new StringParameter(this, 'ReleaseImageTag', {
      parameterName: `/cms/${props.environment}/release-tag`,
      stringValue: bootstrapAsset.imageTag,
    });
    const logGroup = new LogGroup(this, 'CMSLogs', {
      logGroupName: 'CMS-Logs',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    let response = this.createService(
      vpc,
      props.config.fargateConfig,
      props.config.alb,
      databaseCredentialsSecret,
      CmsFileSystem,
      accessPoint,
      logGroup
    );
    this.fargateService = response.service.service;
    this.fargateAlb = response.service.loadBalancer;
    CmsFileSystem.connections.allowDefaultPortFrom(
      this.fargateService.connections
    );

    new RedisStack(this, 'Redis', {
      redis: props.config.redis,
      vpc: vpc,
    });
  }

  createService(
    vpc: Vpc,
    fargateConfig: FargateConfig,
    albConfig: AlbConfig,
    databaseCredentialsSecret: Secret,
    CmsFileSystem: FileSystem,
    accessPoint: AccessPoint,
    logGroup: LogGroup
  ): {
    service: ApplicationLoadBalancedFargateService;
    port: number;
  } {
    const taskDef = new FargateTaskDefinition(this, 'TaskDefinition', {
      memoryLimitMiB: 1024,
      volumes: [
        {
          name: 'efs',
          efsVolumeConfiguration: {
            fileSystemId: CmsFileSystem.fileSystemId,
            authorizationConfig: {
              accessPointId: accessPoint.accessPointId,
            },
            transitEncryption: 'ENABLED',
          },
        },
      ],
    });

    const appPort = 3000;
    const definition = taskDef.addContainer('cms', {
      image: ContainerImage.fromEcrRepository(
        Repository.fromRepositoryAttributes(this, 'BootstrapRepo', {
          repositoryArn: this.releaseArn.stringValue,
          repositoryName: this.releaseName.stringValue,
        }),
        this.releaseTag.stringValue
      ),
      logging: new AwsLogDriver({ streamPrefix: 'cms', logGroup }),
      portMappings: [{ containerPort: appPort }],
      environment: {
        PORT: `${appPort}`,
      },
      healthCheck: {
        command: [`curl -f http://localhost:${appPort}/admin || exit 1`],
      },
      secrets: {
        MONGODB_USERNAME: EcsSecret.fromSecretsManager(
          databaseCredentialsSecret,
          'username'
        ),
        MONGODB_PASSWORD: EcsSecret.fromSecretsManager(
          databaseCredentialsSecret,
          'password'
        ),
        MONGODB_HOST: EcsSecret.fromSecretsManager(
          databaseCredentialsSecret,
          'host'
        ),
        MONGODB_PORT: EcsSecret.fromSecretsManager(
          databaseCredentialsSecret,
          'port'
        ),
        MONGODB_USE_SSL: EcsSecret.fromSecretsManager(
          databaseCredentialsSecret,
          'ssl'
        ),
      },
    });

    definition.addMountPoints({
      // TODO: Add the path to mount EFS volume
      containerPath: '/home/node/dist/media',
      sourceVolume: 'efs',
      readOnly: false,
    });

    for (let key in fargateConfig.env) {
      definition.addEnvironment(key, fargateConfig.env[key]);
    }

    let secretId = 0;
    for (let { ssmParameter, fields } of fargateConfig.secrets) {
      let secret = Secret.fromSecretCompleteArn(
        this,
        `Secret${secretId}`,
        ssmParameter
      );
      secretId += 1;
      for (let field of fields) {
        definition.addSecret(
          field,
          EcsSecret.fromSecretsManager(secret, field)
        );
      }
    }
    const svcSg = new SecurityGroup(this, 'DefaultSg', {
      securityGroupName: 'FargateService',
      vpc: vpc,
    });
    svcSg.addIngressRule(
      Peer.ipv4(this.vpc.vpcCidrBlock),
      Port.tcp(3000),
      'Allow Inbound traffic from vpc on 3000/tcp'
    );
    const service = new ApplicationLoadBalancedFargateService(this, 'Service', {
      assignPublicIp: false,
      minHealthyPercent: 100, // for zero downtime rolling deployment set desiredcount=2 and minHealty = 50
      desiredCount: 1,
      taskDefinition: taskDef,
      certificate: Certificate.fromCertificateArn(
        this,
        'AlbCertificate',
        albConfig.certificate
      ),
      redirectHTTP: true,
      vpc: vpc,
      securityGroups: [svcSg],
      cloudMapOptions: {
        name: 'payload',
        cloudMapNamespace: new PrivateDnsNamespace(this, 'ns', {
          name: 'cms.arpa',
          vpc: vpc,
        }),
        containerPort: appPort,
      },
    });

    service.targetGroup.configureHealthCheck({
      enabled: true,
      path: '/', // "/admin" returns 404 for some reason!?
      healthyHttpCodes: '200,302',
    });
    // Allow the task definition to pull images from ECR
    this.ecr.grantPull(service.taskDefinition.obtainExecutionRole());

    new CfnOutput(this, 'PrivateDNSName', {
      description: 'Private DNS Name',
      value: 'base.cms.arpa',
    });

    new CfnOutput(this, 'AlbDNSName', {
      value: service.loadBalancer.loadBalancerDnsName,
      description: 'DNS of ALB in this stack',
    });
    return {
      service,
      port: appPort,
    };
  }
}
