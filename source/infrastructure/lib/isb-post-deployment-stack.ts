// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack, type StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import path from "path";

import {
  sharedAccountPoolSsmParamName,
  sharedDataSsmParamName,
  sharedIdcSsmParamName,
} from "@amzn/innovation-sandbox-commons/types/isb-types";
import { SharedJsonParamEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/shared-json-param-parser-environment.js";
import { IsbLambdaFunctionCustomResource } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function-custom-resource";
import {
  addParameterGroup,
  ParameterWithLabel,
} from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import { NamespaceParam } from "@amzn/innovation-sandbox-infrastructure/helpers/namespace-param";
import { applyIsbTag } from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";
import { IsbPostDeploymentResources } from "@amzn/innovation-sandbox-infrastructure/isb-post-deployment-resources";
import { Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";

export class IsbPostDeploymentStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    /* solution input parameters */
    const namespaceParam = new NamespaceParam(this);

    const orgMgtAccountId = new ParameterWithLabel(this, "OrgMgtAccountId", {
      label: "Org Management Account Id",
      description:
        "The AWS Account Id of the org's management account where the account pool stack is deployed",
      allowedPattern: "^[0-9]{12}$",
    });

    const idcAccountId = new ParameterWithLabel(this, "IdcAccountId", {
      label: "IDC Account Id",
      description:
        "The AWS Account Id where the IAM Identity Center is configured",
      allowedPattern: "^[0-9]{12}$",
    });

    const webAppUrl = new ParameterWithLabel(this, "WebAppUrl", {
      label: "Web Application URL",
      description:
        "The URL of the deployed web application (CloudFront URL for commercial, ALB URL for GovCloud)",
      allowedPattern: "^https://.*",
    });

    const awsAccessPortalUrl = new ParameterWithLabel(
      this,
      "AwsAccessPortalUrl",
      {
        label: "AWS Access Portal URL",
        description:
          "The URL of the AWS Access Portal (IAM Identity Center login page)",
        allowedPattern: "^https://.*",
      },
    );

    const notificationEmailFrom = new ParameterWithLabel(
      this,
      "NotificationEmailFrom",
      {
        label: "Notification Email From Address",
        description:
          "The email address to use in the 'from' field of all email notifications",
        allowedPattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
      },
    );

    const ssoInstanceArn = new ParameterWithLabel(this, "SsoInstanceArn", {
      label: "IAM Identity Center Instance ARN",
      description:
        "The ARN of the IAM Identity Center instance (from IDC_REGION)",
      allowedPattern: "^arn:aws(-us-gov)?:sso:::instance/ssoins-[a-f0-9]{16}$",
    });

    const identityStoreId = new ParameterWithLabel(this, "IdentityStoreId", {
      label: "Identity Store ID",
      description:
        "The Identity Store ID (starts with d-) from IAM Identity Center",
      allowedPattern: "^d-[a-f0-9]{10}$",
    });

    addParameterGroup(this, {
      label: "Post-Deployment Stack Configuration",
      parameters: [
        namespaceParam.namespace,
        orgMgtAccountId,
        idcAccountId,
        webAppUrl,
        awsAccessPortalUrl,
        notificationEmailFrom,
        ssoInstanceArn,
        identityStoreId,
      ],
    });

    // Create SharedJsonParamResolver with unique Lambda function name
    const idcConfigParamArn = this.formatArn({
      service: "ssm",
      account: idcAccountId.valueAsString,
      resource: "parameter",
      resourceName: sharedIdcSsmParamName(
        namespaceParam.namespace.valueAsString,
      ),
    });

    const accountPoolConfigParamArn = this.formatArn({
      service: "ssm",
      account: orgMgtAccountId.valueAsString,
      resource: "parameter",
      resourceName: sharedAccountPoolSsmParamName(
        namespaceParam.namespace.valueAsString,
      ),
    });

    const dataConfigParamArn = this.formatArn({
      service: "ssm",
      resource: "parameter",
      resourceName: sharedDataSsmParamName(
        namespaceParam.namespace.valueAsString,
      ),
    });

    // Create a custom resource with unique function name to avoid conflicts
    const { customResource: sharedParamCR, lambdaFunction: sharedParamLambda } =
      new IsbLambdaFunctionCustomResource(
        this,
        "PostDeploymentParseJsonConfig",
        {
          description:
            "Parses configuration passed in JSON format for Post-Deployment",
          entry: path.join(
            __dirname,
            "..",
            "..",
            "lambdas",
            "custom-resources",
            "shared-json-param-parser",
            "src",
            "shared-json-param-parser-handler.ts",
          ),
          handler: "handler",
          namespace: namespaceParam.namespace.valueAsString,
          envSchema: SharedJsonParamEnvironmentSchema,
          environment: {},
          customResourceType: "Custom::PostDeploymentParseJsonConfiguration",
          customResourceProperties: {
            idcConfigParamArn,
            accountPoolConfigParamArn,
            dataConfigParamArn,
            namespace: namespaceParam.namespace.valueAsString,
            forceUpdate: new Date().getTime(),
          },
        },
      );

    const ssmReadPolicy = new Policy(this, "SharedParamReaderSsmReadPolicy", {
      statements: [
        new PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            idcConfigParamArn,
            accountPoolConfigParamArn,
            dataConfigParamArn,
          ],
        }),
      ],
    });

    sharedParamLambda.role?.attachInlinePolicy(ssmReadPolicy);

    // Create post-deployment configuration resources
    const postDeploymentResources = new IsbPostDeploymentResources(
      this,
      "PostDeploymentResources",
      {
        namespace: namespaceParam.namespace.valueAsString,
        webAppUrl,
        awsAccessPortalUrl: awsAccessPortalUrl.valueAsString,
        notificationEmailFrom: notificationEmailFrom.valueAsString,
        ssoInstanceArn: ssoInstanceArn.valueAsString,
        identityStoreId: identityStoreId.valueAsString,
        idcAccountId: idcAccountId.valueAsString,
        appConfigApplication: sharedParamCR.getAttString(
          "configApplicationId",
        ),
        appConfigEnvironment: sharedParamCR.getAttString("configEnvironmentId"),
        appConfigConfigProfile: sharedParamCR.getAttString(
          "globalConfigConfigurationProfileId",
        ),
      },
    );

    // Apply ISB tags
    applyIsbTag(this, namespaceParam.namespace.valueAsString);

    // Outputs
    new CfnOutput(this, "PostDeploymentStatus", {
      description: "Post-deployment configuration status",
      value: postDeploymentResources.status,
    });

    new CfnOutput(this, "ConfiguredWebAppUrl", {
      description: "Web Application URL configured in AppConfig",
      value: webAppUrl.valueAsString,
    });

    new CfnOutput(this, "ConfiguredAwsAccessPortalUrl", {
      description: "AWS Access Portal URL configured in AppConfig",
      value: awsAccessPortalUrl.valueAsString,
    });

    new CfnOutput(this, "NextSteps", {
      description: "Required manual configuration steps",
      value:
        "See POST-DEPLOYMENT-README.md for instructions on creating the SAML application manually",
    });
  }
}
