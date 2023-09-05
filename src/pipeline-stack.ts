import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  BuildSpec,
  Cache,
  ComputeType,
  LinuxBuildImage,
  LocalCacheMode,
  PipelineProject,
} from 'aws-cdk-lib/aws-codebuild';
import { Artifact, Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import {
  CodeBuildAction,
  CodeStarConnectionsSourceAction,
  EcsDeployAction,
  ManualApprovalAction,
} from 'aws-cdk-lib/aws-codepipeline-actions';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { FargateService } from 'aws-cdk-lib/aws-ecs';
import {
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { RepoEntry } from './config';

interface PipelineStackProps extends StackProps {
  readonly repo: RepoEntry;
  readonly codestarConnectionArn: string;
  readonly ecr: Repository;
  readonly environment: string;
  readonly fargateService: FargateService;
  readonly releaseParameters: {
    readonly releaseArn: StringParameter;
    readonly releaseName: StringParameter;
    readonly releaseTag: StringParameter;
  };
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const srcArtifact = new Artifact();
    let pipeline = new Pipeline(this, 'Pipeline', {
      pipelineName: `${props.repo.owner}-${props.repo.repo}-${props.environment}`,
      restartExecutionOnUpdate: true,
      artifactBucket: new Bucket(this, 'ArtifactsBucket', {
        autoDeleteObjects: true,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    pipeline.addStage({
      stageName: 'Pull_Source_Code',
      actions: [
        new CodeStarConnectionsSourceAction({
          actionName: 'Pull_CMS_CODE',
          connectionArn: props.codestarConnectionArn,
          output: srcArtifact,
          owner: props.repo.owner,
          repo: props.repo.repo,
          branch: props.repo.branch,
        }),
      ],
    });

    const sourceBuildActionRole = new Role(this, 'BuildSourceRole', {
      assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
      description: 'Role used by build source role',
      inlinePolicies: {
        // Permissions here have to be a bit "wider" than what is required because aws is stupid.
        cloudwatch: new PolicyDocument({
          assignSids: true,
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/*`,
              ],
            }),
          ],
        }),
        codebuild: new PolicyDocument({
          assignSids: true,
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              resources: [
                `arn:aws:codebuild:${this.region}:${this.account}:report-group/*`,
              ],
              actions: [
                'codebuild:CreateReportGroup',
                'codebuild:CreateReport',
                'codebuild:UpdateReport',
                'codebuild:BatchPutTestCases',
                'codebuild:BatchPutCodeCoverages',
              ],
            }),
          ],
        }),
        s3: new PolicyDocument({
          assignSids: true,
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              resources: [
                pipeline.artifactBucket.bucketArn,
                pipeline.artifactBucket.arnForObjects('*'),
              ],
              actions: ['s3:GetObject*', 's3:GetBucket*', 's3:List*'],
            }),
          ],
        }),
        ecr: new PolicyDocument({
          assignSids: true,
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              resources: [props.ecr.repositoryArn],
              actions: [
                'ecr:PutImage',
                'ecr:InitiateLayerUpload',
                'ecr:UploadLayerPart',
                'ecr:CompleteLayerUpload',
              ],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              resources: [props.ecr.repositoryArn],
              actions: [
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
              ],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              resources: ['*'],
              actions: ['ecr:GetAuthorizationToken'],
            }),
          ],
        }),
        secretsmanager: new PolicyDocument({
          assignSids: true,
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              resources: [
                `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
              ],
              actions: ['secretsmanager:GetSecretValue'],
            }),
          ],
        }),
        ssm: new PolicyDocument({
          assignSids: true,
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              resources: [
                props.releaseParameters.releaseArn.parameterArn,
                props.releaseParameters.releaseName.parameterArn,
                props.releaseParameters.releaseTag.parameterArn,
              ],
              actions: [
                'ssm:GetParameters',
                'ssm:GetParameter',
                'ssm:GetParameterHistory',
              ],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              resources: ['*'],
              actions: ['ssm:DescribeParameters'],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              resources: [
                props.releaseParameters.releaseArn.parameterArn,
                props.releaseParameters.releaseName.parameterArn,
                props.releaseParameters.releaseTag.parameterArn,
              ],
              actions: ['ssm:PutParameter'],
            }),
          ],
        }),
      },
    });
    sourceBuildActionRole.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const buildOutput = new Artifact();
    // TODO: Move this some where else with higher visibility
    const containerName = 'cms';
    const buildAction = new CodeBuildAction({
      actionName: 'BuildSource',
      input: srcArtifact,
      outputs: [buildOutput],
      runOrder: 2,
      project: new PipelineProject(this, 'PipelineProject', {
        cache: Cache.local(LocalCacheMode.DOCKER_LAYER),
        environment: {
          computeType: ComputeType.MEDIUM,
          privileged: true,
          buildImage: LinuxBuildImage.STANDARD_4_0,
        },
        role: sourceBuildActionRole,
        environmentVariables: {
          REPOSITORY_URI: { value: props.ecr.repositoryUri },
        },
        buildSpec: BuildSpec.fromObject({
          version: 0.2,
          phases: {
            install: {
              'runtime-versions': {
                docker: '19',
              },
            },
            pre_build: {
              commands: [
                'echo Logging into ECR',
                `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
                'COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)',
                'IMAGE_TAG=${COMMIT_HASH:=latest}',
              ],
            },
            build: {
              commands: [
                // NEXT_PUBLIC_ENV_NAME in `next.config.js` is set to `this.environment` in upper case
                // `sed -i 's/DEV/${props.environment.toUpperCase()}/g' next.config.js`,

                // Change target to `serverless`
                // 'sed -i "s/server/serverless/g" next.config.js',

                // This certificate is used to talk to doc db
                'curl -o rdsCA.pem https://s3.amazonaws.com/rds-downloads/rds-combined-ca-bundle.pem',

                // Build the `Dockerfile.cms` image
                `docker build --build-arg=RDS_CA_LOCATION=rdsCA.pem -f Dockerfile -t ${props.ecr.repositoryUri}:latest $CODEBUILD_SRC_DIR`,
                `docker tag ${props.ecr.repositoryUri}:latest ${props.ecr.repositoryUri}:$IMAGE_TAG`,
              ],
            },
            post_build: {
              commands: [
                `docker push ${props.ecr.repositoryUri}:latest`,
                `docker push ${props.ecr.repositoryUri}:$IMAGE_TAG`,

                // Update the 3 SSM Parameters
                `aws ssm put-parameter --overwrite --region ${this.region} --name ${props.releaseParameters.releaseTag.parameterName} --value $IMAGE_TAG`,
                `aws ssm put-parameter --overwrite --region ${this.region} --name ${props.releaseParameters.releaseArn.parameterName} --value ${props.ecr.repositoryArn}`,
                `aws ssm put-parameter --overwrite --region ${this.region} --name ${props.releaseParameters.releaseName.parameterName} --value ${props.ecr.repositoryName}`,

                `printf "[{\\"name\\":\\"${containerName}\\",\\"imageUri\\":\\"${props.ecr.repositoryUri}:latest\\"}]" > imagedefinitions.json`,
              ],
            },
          },
          artifacts: {
            files: ['imagedefinitions.json'],
          },
        }),
      }),
    });

    pipeline.node.addDependency(sourceBuildActionRole);
    if (props.environment !== 'dev') {
      pipeline.addStage({
        stageName: 'ApproveDeployment',
        actions: [
          new ManualApprovalAction({
            actionName: 'ApproveDeployment',
          }),
        ],
      });
    }
    pipeline.addStage({
      stageName: 'Build',
      actions: [buildAction],
    });

    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new EcsDeployAction({
          actionName: 'DeployToECS',
          input: buildOutput,
          service: props.fargateService,
        }),
      ],
    });
  }
}
