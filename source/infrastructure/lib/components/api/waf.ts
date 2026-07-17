// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  ArnFormat,
  Aws,
  Duration,
  RemovalPolicy,
  Stack,
  Token,
} from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { IKey } from "aws-cdk-lib/aws-kms";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import {
  CfnIPSet,
  CfnLoggingConfiguration,
  CfnWebACL,
  CfnWebACLAssociation,
} from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { isDevMode } from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";
import { isGovCloud } from "@amzn/innovation-sandbox-infrastructure/helpers/govcloud-mode";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";

export interface WafProps {
  namespace: string;
  resourceArn: string;
  allowListedCidr: string[];
  kmsKey: IKey;
  /**
   * How the allow-list and rate-limit rules identify the client IP.
   *
   * - `false` (default): read the client IP from the `X-Forwarded-For` header.
   *   Correct when the WAF is associated with API Gateway *behind CloudFront*,
   *   which injects a trustworthy `X-Forwarded-For`. This is the commercial
   *   default and keeps synth output byte-identical.
   * - `true`: use the connection source IP directly. Required when the WAF is
   *   associated with an internet-/VPC-facing ALB, because WAF evaluates the
   *   request *before* the ALB appends its own `X-Forwarded-For`. Reading XFF
   *   here would (a) block legitimate browsers that send no XFF and (b) let a
   *   caller spoof an allow-listed IP via a forged `X-Forwarded-For` header.
   */
  useSourceIp?: boolean;
  /**
   * Optional suffix to disambiguate the WAF log-group name. Required when more
   * than one Waf exists in the same stack (e.g. alb-s3 mode has both an ALB WAF
   * and the private API Gateway WAF), since the log-group name is fixed and
   * would otherwise collide. Commercial (single WAF) omits it, keeping the
   * original name.
   */
  logGroupSuffix?: string;
}

export class Waf extends Construct {
  public readonly webAcl: CfnWebACL;
  public readonly wafLogGroup: LogGroup;
  public readonly blockedRequestsAlarm: Alarm;

  constructor(scope: Construct, id: string, props: WafProps) {
    super(scope, id);

    const ipSet = new CfnIPSet(this, "IPSet", {
      addresses: props.allowListedCidr.map((cidr) => cidr.trim()),
      ipAddressVersion: "IPV4",
      scope: "REGIONAL",
    });

    // When associated with an ALB, key off the connection source IP; when
    // behind CloudFront (commercial default), trust the injected XFF header.
    const useSourceIp = props.useSourceIp ?? false;

    const allowListIpSetStatement = useSourceIp
      ? { arn: ipSet.attrArn }
      : {
          arn: ipSet.attrArn,
          ipSetForwardedIpConfig: {
            headerName: "X-Forwarded-For",
            fallbackBehavior: "NO_MATCH",
            position: "FIRST",
          },
        };

    // GovCloud WAFv2 does not support the custom rate-limit evaluation window
    // (it rejects any request containing EvaluationWindowSec with
    // "fields that belong to a feature you are not allowed to use"). Omit it
    // there so the rule uses the default 300s window; commercial keeps 60s.
    const rateWindow = isGovCloud(scope) ? {} : { evaluationWindowSec: 60 };

    const rateBasedStatement = useSourceIp
      ? {
          ...rateWindow,
          limit: 200,
          aggregateKeyType: "IP",
        }
      : {
          ...rateWindow,
          limit: 200,
          aggregateKeyType: "FORWARDED_IP",
          forwardedIpConfig: {
            headerName: "X-Forwarded-For",
            fallbackBehavior: "MATCH",
          },
        };

    this.webAcl = new CfnWebACL(this, "WebAcl", {
      defaultAction: { allow: {} },
      scope: "REGIONAL",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "IsbWebAclMetric",
        sampledRequestsEnabled: true,
      },
      customResponseBodies: {
        TooManyRequests: {
          contentType: "APPLICATION_JSON",
          content: JSON.stringify({
            message: "Too many requests",
          }),
        },
      },
      rules: [
        {
          name: "IsbAllowListRule",
          priority: 0,
          action: {
            block: {},
          },
          statement: {
            notStatement: {
              statement: {
                ipSetReferenceStatement: allowListIpSetStatement,
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "IsbAllowListRuleMetric",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "IsbRateLimitRule",
          priority: 1,
          action: {
            block: {
              customResponse: {
                responseCode: 429,
                customResponseBodyKey: "TooManyRequests",
              },
            },
          },
          statement: {
            rateBasedStatement,
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "IsbRateLimitRuleMetric",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesCommonRuleSet",
              vendorName: "AWS",
              excludedRules: [
                {
                  name: "SizeRestrictions_BODY",
                },
                {
                  name: "SizeRestrictions_QUERYSTRING",
                },
                {
                  name: "CrossSiteScripting_BODY",
                },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesCommonRuleSetMetric",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesAmazonIpReputationList",
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesAmazonIpReputationList",
              vendorName: "AWS",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesAmazonIpReputationListMetric",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesAnonymousIpList",
          priority: 4,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesAnonymousIpList",
              vendorName: "AWS",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesAnonymousIpListMetric",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: props.resourceArn,
      webAclArn: this.webAcl.attrArn,
    });

    this.wafLogGroup = new LogGroup(this, "WafLogGroup", {
      logGroupName: `aws-waf-logs-isb-${props.namespace}${
        props.logGroupSuffix ? `-${props.logGroupSuffix}` : ""
      }-blocked-requests`,
      encryptionKey: props.kmsKey,
      removalPolicy: isDevMode(scope)
        ? RemovalPolicy.DESTROY
        : RemovalPolicy.RETAIN,
      retention: Token.asNumber(
        getContextFromMapping(scope, "cloudWatchLogRetentionInDays"),
      ),
    });
    addCfnGuardSuppression(this.wafLogGroup, [
      "CW_LOGGROUP_RETENTION_PERIOD_CHECK",
    ]); // Retention period is defined in CfnMapping and evades the CFN Guard check

    this.wafLogGroup.grantWrite(new ServicePrincipal("wafv2.amazonaws.com"));

    new CfnLoggingConfiguration(this, "WafLoggingConfiguration", {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [
        Stack.of(this).formatArn({
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          service: "logs",
          resource: "log-group",
          resourceName: this.wafLogGroup.logGroupName,
        }),
      ],
      loggingFilter: {
        DefaultBehavior: "DROP",
        Filters: [
          {
            Behavior: "KEEP",
            Conditions: [
              {
                ActionCondition: {
                  Action: "BLOCK",
                },
              },
            ],
            Requirement: "MEETS_ANY",
          },
        ],
      },
      redactedFields: [
        {
          singleHeader: {
            Name: "Authorization",
          },
        },
      ],
    });

    const blockedRequestsMetric = new Metric({
      namespace: "AWS/WAFV2",
      metricName: "BlockedRequests",
      dimensionsMap: {
        Rule: "ALL",
        WebACL: this.webAcl.webAclRef.webAclName,
        Region: Aws.REGION,
      },
      statistic: "Sum",
      period: Duration.minutes(1),
    });

    this.blockedRequestsAlarm = new Alarm(this, "WafBlockedRequestsAlarm", {
      alarmDescription:
        "Alert when WAF blocks requests to the Innovation Sandbox API - may indicate misconfigured WAF rules blocking legitimate users",
      metric: blockedRequestsMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}
