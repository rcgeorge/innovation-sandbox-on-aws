// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ArnFormat, Duration, Fn, Stack } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { IdcConfigurerLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/idc-configurer-lambda-environment.js";
import { IsbLambdaFunctionCustomResource } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function-custom-resource";

export type IdcConfigurerProps = {
  namespace: string;
  identityStoreId: string;
  ssoInstanceArn: string;
  idcRegion: string;
  idcKmsKeyArn: string;
  adminGroupName: string;
  managerGroupName: string;
  userGroupName: string;
};

export class IdcConfigurer extends Construct {
  public readonly adminGroupId: string;
  public readonly managerGroupId: string;
  public readonly userGroupId: string;
  public readonly adminPermissionSetArn: string;
  public readonly managerPermissionSetArn: string;
  public readonly userPermissionSetArn: string;

  constructor(scope: Construct, id: string, props: IdcConfigurerProps) {
    super(scope, id);

    const { customResource, lambdaFunction } =
      new IsbLambdaFunctionCustomResource(this, "IdcConfigurerLambdaFunction", {
        description: "Custom resource lambda that configures the IDC instance",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "custom-resources",
          "idc-configurer",
          "src",
          "idc-configurer-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        customResourceType: "Custom::IdcConfigurer",
        envSchema: IdcConfigurerLambdaEnvironmentSchema,
        environment: {
          POWERTOOLS_SERVICE_NAME: "IdcConfigurer",
        },
        timeout: Duration.minutes(15),
        customResourceProperties: {
          namespace: props.namespace,
          identityStoreId: props.identityStoreId,
          ssoInstanceArn: props.ssoInstanceArn,
          idcRegion: props.idcRegion,
          adminGroupName: props.adminGroupName,
          managerGroupName: props.managerGroupName,
          userGroupName: props.userGroupName,
        },
      });

    this.adminGroupId = customResource.getAttString("adminGroupId");
    this.managerGroupId = customResource.getAttString("managerGroupId");
    this.userGroupId = customResource.getAttString("userGroupId");
    this.adminPermissionSetArn = customResource.getAttString(
      "adminPermissionSetArn",
    );
    this.managerPermissionSetArn = customResource.getAttString(
      "managerPermissionSetArn",
    );
    this.userPermissionSetArn = customResource.getAttString(
      "userPermissionSetArn",
    );

    const identityStoreArn = Stack.of(scope).formatArn({
      service: "identitystore",
      resource: "identitystore",
      region: "",
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      resourceName: props.identityStoreId,
    });

    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["identitystore:CreateGroup"],
        resources: [identityStoreArn],
      }),
    );

    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["identitystore:GetGroupId"],
        resources: [
          identityStoreArn,
          Stack.of(scope).formatArn({
            service: "identitystore",
            region: "",
            account: "",
            resource: "group",
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            resourceName: "*",
          }),
        ],
      }),
    );

    const instanceId = Fn.select(1, Fn.split("/", props.ssoInstanceArn));

    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["sso:ListPermissionSets", "sso:DescribePermissionSet"],
        resources: [
          props.ssoInstanceArn,
          Stack.of(scope).formatArn({
            service: "sso",
            account: "",
            region: "",
            resource: "permissionSet",
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            resourceName: `${instanceId}/*`,
          }),
        ],
      }),
    );

    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "sso:CreatePermissionSet",
          "sso:AttachManagedPolicyToPermissionSet",
        ],
        resources: [
          props.ssoInstanceArn,
          Stack.of(scope).formatArn({
            service: "sso",
            account: "",
            region: "",
            resource: "permissionSet",
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            resourceName: `${instanceId}/*`,
          }),
        ],
      }),
    );

    // Add KMS decrypt permission required for sso:CreatePermissionSet
    // Only add if a customer-managed or AWS-managed key ARN is provided
    // (AWS owned keys don't have ARNs and don't require explicit permissions)
    //
    // Check if the KMS key ARN is a real ARN (starts with "arn:")
    // If it's "AWS_OWNED_KEY" or a placeholder, skip adding the policy
    const isRealKmsKeyArn =
      props.idcKmsKeyArn &&
      props.idcKmsKeyArn.startsWith("arn:") &&
      !props.idcKmsKeyArn.includes("00000000-0000-0000-0000-000000000000");

    if (isRealKmsKeyArn) {
      lambdaFunction.addToRolePolicy(
        new PolicyStatement({
          actions: ["kms:Decrypt"],
          resources: [props.idcKmsKeyArn],
        }),
      );
    }
  }
}
