import { NestedStack, NestedStackProps, RemovalPolicy } from 'aws-cdk-lib';
import {
  BuildEnvironmentVariable,
  BuildEnvironmentVariableType,
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
  LambdaInvokeAction,
  ManualApprovalAction,
} from 'aws-cdk-lib/aws-codepipeline-actions';
import { IVpc } from 'aws-cdk-lib/aws-ec2';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import {
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { RepoEntry } from '../config';

interface AppPipelineStackProps extends NestedStackProps {
  readonly name: string;
  readonly ecr: Repository;
  readonly vpc: IVpc;
  readonly updaterLambda: IFunction;
  readonly releaseParameters: {
    readonly releaseTag: StringParameter;
    readonly releaseName: StringParameter;
    readonly releaseArn: StringParameter;
    readonly packageVersion: StringParameter;
  };
  readonly repo: RepoEntry;
  readonly buildEnv: {
    readonly [name: string]: string;
  };
  readonly artifactsBucket: Bucket;
  readonly environment: string;
}

export class AppPipelineStack extends NestedStack {
  constructor(scope: Construct, id: string, props: AppPipelineStackProps) {
    super(scope, id, props);

    // TODO:
    // 1. build the project using code pipeline
    // 2. push images to ecr
    // 3. write a custom resource to update lambda function
    // code build sohould run in a vpc otherwise the builds will fail

    const srcArtifact = new Artifact();
    let pipeline = new Pipeline(this, 'Pipeline', {
      pipelineName: `${props.repo.owner}-${props.repo.repo}-${props.name}`,
      restartExecutionOnUpdate: true,
      artifactBucket: props.artifactsBucket,
      stages: [
        {
          stageName: 'Pull_Source_Code',
          actions: [
            new CodeStarConnectionsSourceAction({
              actionName: 'Pull_Payload_Infra',
              connectionArn: props.repo.codestarConnectionArn,
              output: srcArtifact,
              owner: props.repo.owner,
              repo: props.repo.repo,
              branch: props.repo.branch,
            }),
          ],
        },
      ],
    });
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
    const payloadCmsBuildActionRole = new Role(this, 'BuildCMSAppRole', {
      assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
      description: 'Role used by build CMS apps',
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
                props.releaseParameters.packageVersion.parameterArn,
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
                props.releaseParameters.packageVersion.parameterArn,
              ],
              actions: ['ssm:PutParameter'],
            }),
          ],
        }),
      },
    });
    payloadCmsBuildActionRole.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const buildVariables: {
      [key: string]: BuildEnvironmentVariable;
    } = {
      REPOSITORY_URI: { value: props.ecr.repositoryUri },
    };

    let buildEnvCmds: string[] = [];

    if (props.buildEnv != null) {
      for (let key in props.buildEnv) {
        let value = props.buildEnv[key];
        let escapedValue = value.replace(/\//g, '\\/');

        let cmd = `sed -i "s/${key}.*/${key}=${escapedValue}/" $CODEBUILD_SRC_DIR/.env || true`;

        // 'sed -i "s/NEXT_PUBLIC_CMS_URL.*/NEXT_PUBLIC_CMS_URL=${NEXT_PUBLIC_CMS_URL//\//\\/}/" $CODEBUILD_SRC_DIR/.env',
        buildEnvCmds.push(cmd);

        buildVariables[key] = {
          value: props.buildEnv[key],
          type: BuildEnvironmentVariableType.PLAINTEXT,
        };
      }
    }

    const buildOutput = new Artifact();
    const payloadCmsBuildAction = new CodeBuildAction({
      actionName: 'BuildCMSApp',
      input: srcArtifact,
      outputs: [buildOutput],
      runOrder: 2,
      project: new PipelineProject(this, 'BuildCMSAppPipeline', {
        cache: Cache.local(LocalCacheMode.DOCKER_LAYER),
        environment: {
          computeType: ComputeType.MEDIUM,
          privileged: true,
          buildImage: LinuxBuildImage.STANDARD_7_0,
        },
        vpc: props.vpc,
        role: payloadCmsBuildActionRole,
        environmentVariables: buildVariables,
        buildSpec: BuildSpec.fromObject({
          version: 0.2,
          env: {
            shell: 'bash',
          },
          phases: {
            install: {
              commands: [
                'curl -L -o /usr/local/bin/jq https://github.com/stedolan/jq/releases/download/jq-1.6/jq-linux64',
                'chmod +x /usr/local/bin/jq',
              ],
            },

            pre_build: {
              commands: [
                'echo Logging into ECR',
                `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
                'COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)',
                'IMAGE_TAG=${COMMIT_HASH:=latest}',
                'PACKAGE_VERSION=$(cat $CODEBUILD_SRC_DIR/package.json | jq -r .version)',
              ],
            },
            build: {
              commands: [
                // Write environment variables that'll be used by the app into $CODEBUILD_SRC_DIR/.env
                // This'll be copied into the container by the docker image build process
                // and then used at build time

                ...buildEnvCmds,
                `echo ${buildEnvCmds.join('\n')}`,
                `docker build -f Dockerfile -t ${props.ecr.repositoryUri}:latest $CODEBUILD_SRC_DIR`,
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
                `aws ssm put-parameter --overwrite --region ${this.region} --name ${props.releaseParameters.packageVersion.parameterName} --value $PACKAGE_VERSION`,
              ],
            },
          },
        }),
      }),
    });

    pipeline.node.addDependency(payloadCmsBuildActionRole);

    pipeline.addStage({
      stageName: 'Build',
      actions: [payloadCmsBuildAction],
    });

    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new LambdaInvokeAction({
          actionName: 'PublishApp',
          lambda: props.updaterLambda,
        }),
      ],
    });
  }
}
