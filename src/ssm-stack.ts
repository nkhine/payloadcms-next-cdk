import {
  CfnOutput,
  // SecretValue,
  StackProps,
} from 'aws-cdk-lib';

import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

import { Construct } from 'constructs';
// import { AppEnvConfig } from './config';
import TaggingStack from './tagging';

interface SsmStackProps extends StackProps {
  //   readonly config: AppEnvConfig;
  //   readonly environment: string;
  readonly ssms: string[];
}

export class SsmStack extends TaggingStack {
  constructor(scope: Construct, id: string, props: SsmStackProps) {
    super(scope, id, props);
    // Add the secrets
    for (let q of props.ssms) {
      const secret = new Secret(this, `${q}`, {
        secretName: `${q}`,
        description: `Key(s) for ${q}`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({}),
          generateStringKey: 'replace me',
        },
      });
      // Outputs
      new CfnOutput(this, `${q}-arn`, {
        value: secret.secretFullArn ? secret.secretFullArn : secret.secretArn,
        description: `Secret ARN for ${q}`,
      });
    }
    // end resource definitions
  }
}
