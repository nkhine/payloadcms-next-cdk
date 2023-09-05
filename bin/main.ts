import { App } from 'aws-cdk-lib';
import { CicdStack } from '../src/cicd';
import { Config } from '../src/config';

const config = new Config('config.yml');
const app = new App();

new CicdStack(app, 'PAYLOADCMS-CICD-STACK', {
  dev: config.dev,
  qa: config.qa,
  prod: config.prod,
  githubTokenArn: config.cicd.githubTokenArn,
  repo: config.cicd.repo,
  env: config.cicd.env,
  accounts: config.accounts,
  ssms: config.ssms,
});
