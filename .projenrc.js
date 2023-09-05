const { awscdk } = require('projen');
const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: '2.87.0',
  cdkVersionPinning: false,
  defaultReleaseBranch: 'main',
  name: 'payloadcms-next-cdk',
  description: `This repo contains infrastructure code for the CMS stack.
    It uses API Gateway with lambda proxy to a Docker image.
  `,
  authorName: 'Norman Khine',
  authorEmail: 'norman@khine.net',
  repository:
    'https://github.com/nkhine/payloadcms-next-cdk',
  authorOrganization: 'nkhine',
  entrypoint: 'bin/main.ts',
  licensed: false,
  gitignore: ['!lib/*.ts', '!bin/*.ts', 'dist', 'cdk.out', 'config.yml'],
  deps: [
    'yaml',
    'cdk-aws-lambda-powertools-layer',
  ] /* Runtime dependencies of this module. */,
  devDeps: ['@types/node', 'cdk-dia'] /* Build dependencies for this module. */,
  context: {},
  dependabot: false,
  autoMerge: true,
  autoApproveUpgrades: true,
  autoApproveOptions: {
    allowedUsernames: ['dependabot[bot]'],
    secret: 'PROJEN_GITHUB_TOKEN',
  },
  buildWorkflow: false,
  releaseWorkflow: false,
  github: true,
  jest: false,
  appEntrypoint: 'main.ts',
  buildCommand: 'make',
  clobber: false,
  srcdir: 'bin',
});

project.addTask('gen-dia', {
  cwd: './docs',
  exec: `
    npx cdk-dia --tree ../cdk.out/tree.json  \
      --include PAYLOADCMS-CICD-STACK \
      --include PAYLOADCMS-CICD-STACK/Dev/CmsStack \
      --include PAYLOADCMS-CICD-STACK/Dev/CmsPipeline \
      --include PAYLOADCMS-CICD-STACK/Dev/CmsWaf \
      --include PAYLOADCMS-CICD-STACK/Dev/CmsAppWrapper
  `,
});

project.synth();
