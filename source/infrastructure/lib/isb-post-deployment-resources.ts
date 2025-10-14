// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Duration } from "aws-cdk-lib";
import { CfnParameter } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";
import { z } from "zod";

import { IsbLambdaFunctionCustomResource } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function-custom-resource";

export interface IsbPostDeploymentResourcesProps {
  namespace: string;
  webAppUrl: CfnParameter;
  awsAccessPortalUrl: string;
  notificationEmailFrom: string;
  ssoInstanceArn: string;
  identityStoreId: string;
  idcAccountId: string;
  appConfigApplication: string;
  appConfigEnvironment: string;
  appConfigConfigProfile: string;
}

const PostDeploymentConfigLambdaEnvironmentSchema = z.object({});

export class IsbPostDeploymentResources extends Construct {
  public readonly status: string;

  constructor(
    scope: Construct,
    id: string,
    props: IsbPostDeploymentResourcesProps,
  ) {
    super(scope, id);

    const { customResource, lambdaFunction } =
      new IsbLambdaFunctionCustomResource(
        this,
        "PostDeploymentConfigLambda",
        {
          description:
            "Custom resource lambda that updates AppConfig with web app URL",
          entry: path.join(
            __dirname,
            "..",
            "..",
            "lambdas",
            "custom-resources",
            "post-deployment-config",
            "src",
            "post-deployment-config-handler.ts",
          ),
          handler: "handler",
          namespace: props.namespace,
          customResourceType: "Custom::PostDeploymentConfig",
          envSchema: PostDeploymentConfigLambdaEnvironmentSchema,
          environment: {
            POWERTOOLS_SERVICE_NAME: "PostDeploymentConfig",
          },
          timeout: Duration.minutes(5),
          customResourceProperties: {
            namespace: props.namespace,
            webAppUrl: props.webAppUrl.valueAsString,
            awsAccessPortalUrl: props.awsAccessPortalUrl,
            notificationEmailFrom: props.notificationEmailFrom,
            ssoInstanceArn: props.ssoInstanceArn,
            identityStoreId: props.identityStoreId,
            idcAccountId: props.idcAccountId,
            appConfigApplication: props.appConfigApplication,
            appConfigEnvironment: props.appConfigEnvironment,
            appConfigConfigProfile: props.appConfigConfigProfile,
          },
        },
      );

    // Add IAM permissions for the Lambda function
    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "appconfig:GetLatestConfiguration",
          "appconfig:StartConfigurationSession",
          "appconfig:CreateHostedConfigurationVersion",
        ],
        resources: ["*"],
      }),
    );

    // Add IAM Identity Center permissions for reading and updating applications
    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "sso:ListApplications",
          "sso:DescribeApplication",
          "sso:UpdateApplication",
        ],
        resources: ["*"],
      }),
    );

    // Add cross-account SSO permissions if IDC is in a different account
    if (props.idcAccountId !== this.node.tryGetContext("account")) {
      lambdaFunction.addToRolePolicy(
        new PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: [
            `arn:aws:iam::${props.idcAccountId}:role/InnovationSandbox-PostDeployment-CrossAccountRole`,
          ],
        }),
      );
    }

    // Extract outputs from custom resource
    this.status = customResource.getAttString("Status");
  }
}
