import * as fs from 'fs';
import { CfnCacheClusterProps } from 'aws-cdk-lib/aws-elasticache';
import * as YAML from 'yaml';

export interface RepoEntry {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly path: string;
  readonly pipelineName: string;
  readonly codestarConnectionArn: string;
}

export interface VpcConfig {
  readonly cidr: string;
  readonly maxAzs: number;
  readonly flowLogBucketArn: string;
  readonly flowLogPrefix: string;
}

export interface AccountConfig {
  id: string;
  name: string;
}

export interface Env {
  readonly name: string;
  readonly account: string;
  readonly region: string;
}

export interface App {
  readonly domain: string;
  readonly certificate: string;
  readonly repo: RepoEntry;
  readonly cms: {
    readonly public: string;
    readonly private: string;
  };
  readonly appEnv: {
    readonly [name: string]: string;
  };
  readonly buildEnv: {
    readonly [name: string]: string;
  };
}

export interface BaseAppConfig {
  readonly env: Env;
}

export interface WorkflowConfig {
  readonly slack: {
    readonly channelId: string;

    // This token is a bot token.
    // It should have,
    // 1. files:write permission to upload files
    // 2. chat:write to send messages
    readonly token: string;
  };
}

export interface CicdStackConfig extends BaseAppConfig {
  readonly repo: RepoEntry;
  readonly githubTokenArn: string;
}

export interface AlbConfig {
  readonly certificate: string;
}

export interface FargateConfig {
  readonly env: {
    readonly [name: string]: string;
  };
  readonly secrets: {
    readonly ssmParameter: string;
    readonly fields: string[];
  }[];
}

// Reference, https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-elasticache-cache-cluster.html
export interface RedisConfig extends CfnCacheClusterProps {}

export interface AppEnvConfig extends BaseAppConfig {
  readonly vpc: VpcConfig;
  readonly workflow: WorkflowConfig;
  readonly alb: AlbConfig;
  readonly fargateConfig: FargateConfig;
  readonly repo: RepoEntry;
  readonly codestarConnectionArn: string;
  readonly cmsSecretsParameter: string;
  readonly allowedIPSet: {
    readonly ipv4: string[];
  };
  readonly redis: RedisConfig;
  readonly apps: {
    [name: string]: App;
  };
  readonly ApiLogBucketArn: string; // Added ApiLogBucketArn to AppEnvConfig interface
}

export class Config {
  readonly cicd: CicdStackConfig;
  readonly dev: AppEnvConfig;
  readonly qa: AppEnvConfig;
  readonly prod: AppEnvConfig;
  readonly accounts: AccountConfig[];
  readonly ssms: string[];

  constructor(fileName?: string) {
    const filename = fileName || 'config.yml';
    const file = fs.readFileSync(filename, 'utf-8');

    const yaml = YAML.parse(file);
    this.cicd = yaml.cicd;
    this.dev = yaml.dev;
    this.qa = yaml.qa;
    this.prod = yaml.prod;
    this.accounts = yaml.accounts;
    this.ssms = yaml.ssms;
    console.log(JSON.stringify(this, null, 2));
  }
}
