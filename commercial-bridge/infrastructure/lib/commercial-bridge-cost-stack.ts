// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as cdk from "aws-cdk-lib";
import {
  AuthorizationType,
  EndpointType,
  LambdaIntegration,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnProfile, CfnTrustAnchor } from "aws-cdk-lib/aws-rolesanywhere";
import { Construct } from "constructs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface CommercialBridgeCostStackProps extends cdk.StackProps {
  /**
   * PEM-encoded CA certificate bundle for the IAM Roles Anywhere trust anchor.
   * When omitted, the trust anchor / profile are not created (deploy the API
   * alone, add the trust anchor once a CA is available).
   */
  caCertificatePem?: string;
  /**
   * Client-certificate common name allowed to assume the bridge role.
   */
  allowedCn: string;
  /**
   * When true, also deploy the GovCloud account-provisioning endpoints
   * (POST/GET /govcloud-accounts, POST /govcloud-accounts/accept-invitation).
   * Defaults to false — the bridge is cost-only unless provisioning is wanted.
   */
  enableAccountProvisioning?: boolean;
}

export class CommercialBridgeCostStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: CommercialBridgeCostStackProps,
  ) {
    super(scope, id, props);

    // ─── Cost Information Lambda ─────────────────────────────────────────────

    const costLambda = new NodejsFunction(this, "CostInformationFunction", {
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(
        __dirname,
        "..",
        "..",
        "lambdas",
        "cost-information",
        "src",
        "handler.ts",
      ),
      handler: "handler",
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });

    costLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ce:GetCostAndUsage"],
        resources: ["*"], // Cost Explorer does not support resource-level scoping
      }),
    );
    costLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["organizations:ListCreateAccountStatus"],
        resources: ["*"],
      }),
    );

    // ─── REST API (IAM-authenticated) ────────────────────────────────────────

    const api = new RestApi(this, "CommercialBridgeApi", {
      restApiName: "CommercialBridgeCostApi",
      description: "Cross-partition cost API for Innovation Sandbox GovCloud",
      endpointConfiguration: { types: [EndpointType.REGIONAL] },
      deployOptions: { stageName: "prod" },
    });

    const costInfo = api.root.addResource("cost-info");
    costInfo.addMethod("POST", new LambdaIntegration(costLambda), {
      authorizationType: AuthorizationType.IAM,
    });

    // ─── GovCloud account provisioning endpoints (optional) ──────────────────

    if (props.enableAccountProvisioning) {
      const accountCreationLambda = new NodejsFunction(
        this,
        "AccountCreationFunction",
        {
          runtime: Runtime.NODEJS_22_X,
          entry: path.join(
            __dirname,
            "..",
            "..",
            "lambdas",
            "account-creation",
            "src",
            "handler.ts",
          ),
          handler: "handler",
          timeout: cdk.Duration.seconds(30),
          memorySize: 256,
        },
      );
      accountCreationLambda.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "organizations:CreateGovCloudAccount",
            "organizations:DescribeCreateAccountStatus",
            "organizations:ListCreateAccountStatus",
          ],
          resources: ["*"], // Organizations account-creation is not resource-scoped
        }),
      );

      const acceptInvitationLambda = new NodejsFunction(
        this,
        "AcceptInvitationFunction",
        {
          runtime: Runtime.NODEJS_22_X,
          entry: path.join(
            __dirname,
            "..",
            "..",
            "lambdas",
            "accept-invitation",
            "src",
            "handler.ts",
          ),
          handler: "handler",
          timeout: cdk.Duration.seconds(60),
          memorySize: 256,
        },
      );
      // Assume OrganizationAccountAccessRole in linked/GovCloud accounts only.
      acceptInvitationLambda.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["sts:AssumeRole"],
          resources: ["arn:*:iam::*:role/OrganizationAccountAccessRole"],
        }),
      );

      const govCloudAccounts = api.root.addResource("govcloud-accounts");
      govCloudAccounts.addMethod(
        "POST",
        new LambdaIntegration(accountCreationLambda),
        { authorizationType: AuthorizationType.IAM },
      );
      govCloudAccounts.addMethod(
        "GET",
        new LambdaIntegration(accountCreationLambda),
        { authorizationType: AuthorizationType.IAM },
      );
      govCloudAccounts
        .addResource("{requestId}")
        .addMethod("GET", new LambdaIntegration(accountCreationLambda), {
          authorizationType: AuthorizationType.IAM,
        });
      govCloudAccounts
        .addResource("accept-invitation")
        .addMethod("POST", new LambdaIntegration(acceptInvitationLambda), {
          authorizationType: AuthorizationType.IAM,
        });
    }

    new cdk.CfnOutput(this, "CommercialBridgeApiUrl", {
      value: api.url,
      description: "Commercial bridge cost API base URL",
    });

    // ─── IAM Roles Anywhere (optional; requires a CA certificate) ────────────

    if (props.caCertificatePem) {
      const trustAnchor = new CfnTrustAnchor(this, "TrustAnchor", {
        name: "CommercialBridge-TrustAnchor",
        enabled: true,
        source: {
          sourceType: "CERTIFICATE_BUNDLE",
          sourceData: { x509CertificateData: props.caCertificatePem },
        },
      });

      // Role assumable via Roles Anywhere, scoped to the trust anchor and the
      // expected client-certificate common name. Grants only execute-api:Invoke
      // on this API.
      const bridgeRole = new Role(this, "BridgeInvokeRole", {
        assumedBy: new ServicePrincipal("rolesanywhere.amazonaws.com"),
      });

      const cfnRole = bridgeRole.node.defaultChild as cdk.aws_iam.CfnRole;
      cfnRole.assumeRolePolicyDocument = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "rolesanywhere.amazonaws.com" },
            Action: [
              "sts:AssumeRole",
              "sts:TagSession",
              "sts:SetSourceIdentity",
            ],
            Condition: {
              StringEquals: {
                "aws:PrincipalTag/x509Subject/CN": props.allowedCn,
              },
              ArnEquals: {
                "aws:SourceArn": trustAnchor.attrTrustAnchorArn,
              },
            },
          },
        ],
      };

      bridgeRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["execute-api:Invoke"],
          resources: [api.arnForExecuteApi("POST", "/cost-info", "prod")],
        }),
      );

      const profile = new CfnProfile(this, "Profile", {
        name: "CommercialBridge-Profile",
        enabled: true,
        roleArns: [bridgeRole.roleArn],
      });

      new cdk.CfnOutput(this, "TrustAnchorArn", {
        value: trustAnchor.attrTrustAnchorArn,
      });
      new cdk.CfnOutput(this, "ProfileArn", {
        value: profile.attrProfileArn,
      });
      new cdk.CfnOutput(this, "BridgeRoleArn", { value: bridgeRole.roleArn });
    }
  }
}
