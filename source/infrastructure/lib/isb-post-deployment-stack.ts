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

    const ssoInstanceArn = new ParameterWithLabel(this, "SsoInstanceArn", {
      label: "SSO Instance ARN",
      description: "The ARN of the IAM Identity Center instance",
    });

    const idcRegion = new ParameterWithLabel(this, "IdcRegion", {
      label: "IDC Region",
      description: "The AWS region where IAM Identity Center is deployed",
      default: "us-east-1",
    });

    addParameterGroup(this, {
      label: "Post-Deployment Stack Configuration",
      parameters: [
        namespaceParam.namespace,
        orgMgtAccountId,
        idcAccountId,
        webAppUrl,
        ssoInstanceArn,
        idcRegion,
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
        ssoInstanceArn,
        idcRegion,
        webAppUrl,
        appConfigApplication: sharedParamCR.getAttString(
          "configApplicationId",
        ),
        appConfigEnvironment: sharedParamCR.getAttString("configEnvironmentId"),
        appConfigConfigProfile: sharedParamCR.getAttString(
          "globalConfigConfigurationProfileId",
        ),
        adminGroupId: sharedParamCR.getAttString("adminGroupId"),
        managerGroupId: sharedParamCR.getAttString("managerGroupId"),
        userGroupId: sharedParamCR.getAttString("userGroupId"),
      },
    );

    // Apply ISB tags
    applyIsbTag(this, namespaceParam.namespace.valueAsString);

    // Outputs
    new CfnOutput(this, "ApplicationArn", {
      description: "IAM Identity Center Application ARN",
      value: postDeploymentResources.applicationArn,
    });

    new CfnOutput(this, "IdpSignInUrl", {
      description: "IAM Identity Center Sign-In URL",
      value: postDeploymentResources.idpSignInUrl,
    });

    new CfnOutput(this, "IdpSignOutUrl", {
      description: "IAM Identity Center Sign-Out URL",
      value: postDeploymentResources.idpSignOutUrl,
    });

    new CfnOutput(this, "PostDeploymentStatus", {
      description: "Post-deployment configuration status",
      value: "Completed - Manual verification may be required for some steps",
    });
  }
}
