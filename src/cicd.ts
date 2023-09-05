import { StackProps, SecretValue, Stage, StageProps } from 'aws-cdk-lib';
import { GitHubTrigger } from 'aws-cdk-lib/aws-codepipeline-actions';
import {
  CodePipeline,
  CodePipelineSource,
  ManualApprovalStep,
  ShellStep,
} from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { AccountConfig, AppEnvConfig, RepoEntry } from './config';
import { GithubSource } from './constructs/github-trigger';
import { SsmStack } from './ssm-stack';
import { PipelineStack } from './pipeline-stack';
import { CmsStack } from './stack';
import TaggingStack from './tagging';
import { WafStack } from './waf';
import { CmsAppsWrapperStack } from './wrapper-stack';

interface CicdStageProps extends StageProps {
  readonly config: AppEnvConfig;
  readonly environment: string;
  readonly accounts: AccountConfig[];
  readonly ssms: string[];
}

class CicdStage extends Stage {
  constructor(scope: Construct, id: string, props: CicdStageProps) {
    super(scope, id, props);

    new SsmStack(this, 'CmsSsmStack', {
      ssms: props.ssms,
    });

    const cmsStack = new CmsStack(this, 'CmsStack', {
      config: props.config,
      env: props.config.env,
      environment: props.environment,
      vpc: props.config.vpc,
    });

    const cmsPipelineStack = new PipelineStack(this, 'CmsPipeline', {
      ecr: cmsStack.ecr,
      codestarConnectionArn: props.config.codestarConnectionArn,
      repo: props.config.repo,
      environment: props.environment,
      fargateService: cmsStack.fargateService,
      releaseParameters: {
        releaseArn: cmsStack.releaseArn,
        releaseName: cmsStack.releaseName,
        releaseTag: cmsStack.releaseTag,
      },
    });
    cmsPipelineStack.addDependency(cmsStack);

    const wafStack = new WafStack(this, 'CmsWaf', {
      fargateAlb: cmsStack.fargateAlb,
      allowedIPSet: props.config.allowedIPSet.ipv4,
    });

    wafStack.addDependency(cmsStack);

    const wrapperStack = new CmsAppsWrapperStack(this, 'CmsAppWrapper', {
      apps: props.config.apps,
      vpc: cmsStack.vpc,
      fileSystemId: cmsStack.cmsFileSystemId,
      environment: props.environment,
      description: 'A wrapper stack for all apps in CMS project',
      ApiLogBucketArn: props.config.ApiLogBucketArn,
      accounts: props.accounts,
    });

    wrapperStack.addDependency(cmsPipelineStack);
  }
}

interface CicdStackProps extends StackProps {
  readonly githubTokenArn: string;
  readonly repo: RepoEntry;
  readonly dev: AppEnvConfig;
  readonly qa: AppEnvConfig;
  readonly prod: AppEnvConfig;
  readonly accounts: AccountConfig[];
  // readonly production: AppEnvConfig;
  readonly ssms: string[];
}

export class CicdStack extends TaggingStack {
  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);
    const oauthToken = SecretValue.secretsManager(props.githubTokenArn);

    const pipeline = new CodePipeline(this, 'CDKPipeline', {
      dockerEnabledForSynth: true,
      pipelineName: props.repo.pipelineName,
      crossAccountKeys: true,
      publishAssetsInParallel: true,
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.gitHub(
          `${props.repo.owner}/${props.repo.repo}`,
          props.repo.branch,
          {
            authentication: oauthToken,
            trigger: GitHubTrigger.NONE,
          }
        ),
        env: {
          GO_VERSION: '1.19',
        },
        installCommands: [
          'wget https://storage.googleapis.com/golang/go${GO_VERSION}.linux-amd64.tar.gz',
          'tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz',
          'export PATH="/usr/local/go/bin:$PATH" && export GOPATH="$HOME/go" && export PATH="$GOPATH/bin:$PATH"',
        ],
        commands: [
          `cd ./${props.repo.path}`,
          'make',

          'yarn install --immutable --immutable-cache --check-cache',
          'npm run build',
          'npx cdk synth',
        ],
        primaryOutputDirectory: `./${props.repo.path}/cdk.out`,
      }),
    });

    pipeline.addStage(
      new CicdStage(this, 'Dev', {
        env: props.dev.env,
        config: props.dev,
        environment: 'dev',
        accounts: props.accounts,
        ssms: props.ssms,
      })
    );
    pipeline.addStage(
      new CicdStage(this, 'QA', {
        env: props.qa.env,
        config: props.qa,
        environment: 'qa',
        accounts: props.accounts,
        ssms: props.ssms,
      }),
      {
        pre: [
          new ManualApprovalStep(
            'Approve deployment of Website to the QA account'
          ),
        ],
      }
    );
    pipeline.addStage(
      new CicdStage(this, 'Prod', {
        env: props.prod.env,
        config: props.prod,
        environment: 'prod',
        accounts: props.accounts,
        ssms: props.ssms,
      }),
      {
        pre: [
          new ManualApprovalStep(
            'Approve deployment of Website to the Production account'
          ),
        ],
      },
    );
    pipeline.buildPipeline();

    const ghSource = new GithubSource(this, 'GithubTrigger', {
      branch: props.repo.branch,
      owner: props.repo.owner,
      repo: props.repo.repo,
      filters: [props.repo.path],
      githubTokenArn: props.githubTokenArn,
      codepipeline: pipeline.pipeline,
    });
    ghSource.node.addDependency(pipeline);
  }
}
