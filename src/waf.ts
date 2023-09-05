import { StackProps } from 'aws-cdk-lib';
import { ApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {
  CfnWebACL,
  CfnWebACLAssociation,
  // CfnIPSet,
} from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import TaggingStack from './tagging';

export interface wafStackProps extends StackProps {
  readonly fargateAlb: ApplicationLoadBalancer;
  readonly allowedIPSet: string[];
}

export class WafStack extends TaggingStack {
  constructor(scope: Construct, id: string, props: wafStackProps) {
    super(scope, id, props);

    /**
     * Setup WAF Rules
     */

    let wafRules: Array<CfnWebACL.RuleProperty> = [];

    // 1 AWS Managed Rules
    let awsManagedRules: CfnWebACL.RuleProperty = {
      name: 'AWS-AWSManagedRulesCommonRuleSet',
      priority: 100,
      statement: {
        managedRuleGroupStatement: {
          name: 'AWSManagedRulesCommonRuleSet',
          vendorName: 'AWS',
          excludedRules: [
            { name: 'SizeRestrictions_BODY' },
            { name: 'SizeRestrictions_QUERYSTRING' },
            { name: 'GenericLFI_QUERYARGUMENTS' },
            { name: 'GenericLFI_URIPATH' },
            { name: 'CrossSiteScripting_BODY' },
          ],
        },
      },
      overrideAction: {
        none: {},
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'awsCommonRules',
        sampledRequestsEnabled: true,
      },
    };

    wafRules.push(awsManagedRules);

    // 2 AWS AnonIPAddress
    // let awsAnonIPList: CfnWebACL.RuleProperty = {
    //   name: 'awsAnonymousIP',
    //   priority: 2,
    //   overrideAction: { none: {} },
    //   statement: {
    //     managedRuleGroupStatement: {
    //       name: 'AWSManagedRulesAnonymousIpList',
    //       vendorName: 'AWS',
    //       excludedRules: [],
    //     },
    //   },
    //   visibilityConfig: {
    //     cloudWatchMetricsEnabled: true,
    //     metricName: 'awsAnonymous',
    //     sampledRequestsEnabled: true,
    //   },
    // };

    // wafRules.push(awsAnonIPList);

    // 3 AWS ip reputation List
    let awsIPRepList: CfnWebACL.RuleProperty = {
      name: 'awsIPReputation',
      priority: 3,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          name: 'AWSManagedRulesAmazonIpReputationList',
          vendorName: 'AWS',
          excludedRules: [],
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'awsReputation',
        sampledRequestsEnabled: true,
      },
    };

    wafRules.push(awsIPRepList);

    // 4 GeoBlock NZ from accessing gateway
    let geoBlockRule: CfnWebACL.RuleProperty = {
      name: 'geoblockRule',
      priority: 4,
      action: { block: {} },
      statement: {
        geoMatchStatement: {
          countryCodes: ['NZ', 'CN', 'PL', 'US'],
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'geoBlock',
        sampledRequestsEnabled: true,
      },
    };

    // Restrict access to all paths under /admin to the ip addreseses in allowedIPSet
    // const allowedIPSet = new CfnIPSet(this, 'AdminAllowedIPSet', {
    //   name: 'AdminAccessAllowed',
    //   ipAddressVersion: 'IPV4',
    //   description: 'Addresses that are allowed to /admin',
    //   addresses: props.allowedIPSet,
    //   scope: 'REGIONAL',
    // });

    // const blockAdminAccess: CfnWebACL.RuleProperty = {
    //   name: 'BlockAdminAccess',
    //   priority: 0,
    //   action: {
    //     block: {},
    //   },
    //   visibilityConfig: {
    //     sampledRequestsEnabled: false,
    //     cloudWatchMetricsEnabled: false,
    //     metricName: 'BlockedAdminAccess',
    //   },
    //   statement: {
    //     andStatement: {
    //       statements: [
    //         {
    //           byteMatchStatement: {
    //             fieldToMatch: {
    //               uriPath: {},
    //             },
    //             positionalConstraint: 'STARTS_WITH',
    //             searchString: '/admin',
    //             textTransformations: [
    //               {
    //                 type: 'NONE',
    //                 priority: 0,
    //               },
    //             ],
    //           },
    //         },
    //         {
    //           notStatement: {
    //             statement: {
    //               ipSetReferenceStatement: {
    //                 arn: allowedIPSet.attrArn,
    //               },
    //             },
    //           },
    //         },
    //       ],
    //     },
    //   },
    // };

    // wafRules.push(blockAdminAccess);
    wafRules.push(geoBlockRule);

    /**
     * Create and Associate ACL with Gateway
     */

    // Create our Web ACL
    let webACL = new CfnWebACL(this, 'WebACL', {
      defaultAction: {
        allow: {},
      },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'webACL',
        sampledRequestsEnabled: true,
      },
      rules: wafRules,
    });

    // Associate with our gateway
    new CfnWebACLAssociation(this, 'WebACLAssociation', {
      webAclArn: webACL.attrArn,
      resourceArn: props.fargateAlb.loadBalancerArn,
    });
  }
}
