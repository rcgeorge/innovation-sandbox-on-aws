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
  ssoInstanceArn: CfnParameter;
  idcRegion: CfnParameter;
  webAppUrl: CfnParameter;
  appConfigApplication: string;
  appConfigEnvironment: string;
  appConfigConfigProfile: string;
  adminGroupId: string;
  managerGroupId: string;
  userGroupId: string;
}

const PostDeploymentConfigLambdaEnvironmentSchema = z.object({});

export class IsbPostDeploymentResources extends Construct {
  public readonly applicationArn: string;
  public readonly idpSignInUrl: string;
  public readonly idpSignOutUrl: string;

  constructor(
    scope: Construct,
    id: string,
    props: IsbPostDeploymentResourcesProps,
  ) {
    super(scope, id);

    const secretName = `/InnovationSandbox/${props.namespace}/Auth/IDPCert`;

    const { customResource, lambdaFunction } =
      new IsbLambdaFunctionCustomResource(
        this,
        "PostDeploymentConfigLambda",
        {
          description:
            "Custom resource lambda that handles post-deployment configuration",
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
            ssoInstanceArn: props.ssoInstanceArn.valueAsString,
            idcRegion: props.idcRegion.valueAsString,
            webAppUrl: props.webAppUrl.valueAsString,
            appConfigApplication: props.appConfigApplication,
            appConfigEnvironment: props.appConfigEnvironment,
            appConfigConfigProfile: props.appConfigConfigProfile,
            secretName: secretName,
            adminGroupId: props.adminGroupId,
            managerGroupId: props.managerGroupId,
            userGroupId: props.userGroupId,
          },
        },
      );

    // Add IAM permissions for the Lambda function
    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "sso:CreateApplication",
          "sso:DeleteApplication",
          "sso:DescribeApplication",
          "sso:UpdateApplication",
          "sso:PutApplicationAssignmentConfiguration",
          "sso:CreateApplicationAssignment",
          "sso:DeleteApplicationAssignment",
        ],
        resources: ["*"],
      }),
    );

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

    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "secretsmanager:CreateSecret",
          "secretsmanager:UpdateSecret",
          "secretsmanager:DescribeSecret",
          "secretsmanager:PutSecretValue",
        ],
        resources: ["*"],
      }),
    );

    // Extract outputs from custom resource
    this.applicationArn = customResource.getAttString("ApplicationArn");
    this.idpSignInUrl = customResource.getAttString("IdpSignInUrl");
    this.idpSignOutUrl = customResource.getAttString("IdpSignOutUrl");
  }
}
