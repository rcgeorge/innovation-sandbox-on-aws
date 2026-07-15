// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * GovCloud front door: internal ALB serving the React SPA from S3 (via
 * interface endpoint) and proxying /api/* to a PRIVATE API Gateway (via
 * execute-api interface endpoint). Uses ALB listener-rule transforms for
 * host-header and URL rewriting — no containers, no Lambda proxies.
 *
 * Selected by the `hostingMode=alb-s3` CDK context flag. When unset, the
 * commercial CloudfrontUiApi construct is used and this code is never
 * instantiated.
 */
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
} from "aws-cdk-lib";
import { RestApi as ApiGatewayRestApi } from "aws-cdk-lib/aws-apigateway";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  IpAddressType,
  ListenerAction,
  ListenerCondition,
  Protocol as ElbProtocol,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
// LogGroup/RetentionDays available if needed for future WAF logging

import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { execSync } from "child_process";
import { existsSync, rmSync } from "fs-extra";
import path from "path";

import { EndpointEniSyncLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/endpoint-eni-sync-lambda-environment.js";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { IsbLogGroups } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-groups";
import { Waf } from "@amzn/innovation-sandbox-infrastructure/components/api/waf";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { isDevMode } from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";

export interface AlbS3UiApiProps {
  restApi: ApiGatewayRestApi;
  namespace: string;
  allowListedCidr: string[];
  /**
   * Optional: ARN of an ACM certificate for HTTPS. If not provided the ALB
   * will listen on HTTP only (suitable for dev/test; production should always
   * provide a cert).
   */
  certificateArn?: string;
}

export class AlbS3UiApi extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly loadBalancer: ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: AlbS3UiApiProps) {
    super(scope, id);
    const kmsKey = IsbKmsKeys.get(scope, props.namespace);

    // ─── VPC ────────────────────────────────────────────────────────────────

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0, // no internet egress needed — all traffic stays in-VPC
      subnetConfiguration: [
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // ─── Interface Endpoints ────────────────────────────────────────────────

    const s3Endpoint = this.vpc.addInterfaceEndpoint("S3Endpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.S3,
      privateDnsEnabled: false, // we'll use the endpoint ENI IPs directly
    });

    const executeApiEndpoint = this.vpc.addInterfaceEndpoint(
      "ExecuteApiEndpoint",
      {
        service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
        privateDnsEnabled: true,
      },
    );

    // ─── SPA S3 Bucket ──────────────────────────────────────────────────────

    const spaBucket = new Bucket(this, "SpaBucket", {
      removalPolicy: isDevMode(scope)
        ? RemovalPolicy.DESTROY
        : RemovalPolicy.RETAIN,
      encryption: BucketEncryption.S3_MANAGED, // interface endpoint → no KMS
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      publicReadAccess: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
    });

    // Allow the S3 interface endpoint to GetObject
    spaBucket.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [new ServicePrincipal("*")],
        actions: ["s3:GetObject"],
        resources: [spaBucket.arnForObjects("*")],
        conditions: {
          StringEquals: {
            "aws:SourceVpce": s3Endpoint.vpcEndpointId,
          },
        },
      }),
    );

    // Deploy the frontend build into the SPA bucket
    new BucketDeployment(this, "DeploySpa", {
      sources: [
        Source.asset(
          buildFrontend(
            path.join(__dirname, "..", "..", "..", "..", "frontend"),
          ),
        ),
      ],
      destinationBucket: spaBucket,
      logGroup: IsbLogGroups.customResourceLogGroup(scope, props.namespace),
    });

    // ─── Internal ALB ───────────────────────────────────────────────────────

    this.loadBalancer = new ApplicationLoadBalancer(this, "Alb", {
      vpc: this.vpc,
      internetFacing: false,
      ipAddressType: IpAddressType.IPV4,
      deletionProtection: !isDevMode(scope),
    });

    addCfnGuardSuppression(this.loadBalancer, [
      "ELB_DELETION_PROTECTION_ENABLED",
    ]);

    // ─── Target Groups (IP type — populated by ENI-sync Lambda) ─────────────

    const s3TargetGroup = new ApplicationTargetGroup(this, "S3TargetGroup", {
      vpc: this.vpc,
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      targetType: TargetType.IP,
      healthCheck: {
        path: "/",
        protocol: ElbProtocol.HTTPS,
        healthyHttpCodes: "200,307,403,404", // S3 may return various on root
        interval: Duration.seconds(30),
      },
    });

    const apiTargetGroup = new ApplicationTargetGroup(
      this,
      "ApiTargetGroup",
      {
        vpc: this.vpc,
        port: 443,
        protocol: ApplicationProtocol.HTTPS,
        targetType: TargetType.IP,
        healthCheck: {
          path: "/",
          protocol: ElbProtocol.HTTPS,
          healthyHttpCodes: "200,403", // execute-api returns 403 on root
          interval: Duration.seconds(30),
        },
      },
    );

    // ─── ENI Sync Lambda ────────────────────────────────────────────────────

    const endpointMappings = [
      `${s3Endpoint.vpcEndpointId}:${s3TargetGroup.targetGroupArn}`,
      `${executeApiEndpoint.vpcEndpointId}:${apiTargetGroup.targetGroupArn}`,
    ].join(",");

    const eniSyncLambda = new IsbLambdaFunction(this, "EniSyncLambda", {
      description:
        "Syncs VPC endpoint ENI IPs into ALB target groups for the ALB+S3 hosting mode",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "custom-resources",
        "endpoint-eni-sync",
        "src",
        "endpoint-eni-sync-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      timeout: Duration.seconds(30),
      environment: {
        ENDPOINT_TARGET_GROUP_MAPPINGS: endpointMappings,
      },
      envSchema: EndpointEniSyncLambdaEnvironmentSchema,
    });

    // Grant permissions to describe ENIs and manage target groups
    eniSyncLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["ec2:DescribeNetworkInterfaces"],
        resources: ["*"],
      }),
    );
    eniSyncLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "elasticloadbalancing:RegisterTargets",
          "elasticloadbalancing:DeregisterTargets",
          "elasticloadbalancing:DescribeTargetHealth",
        ],
        resources: [s3TargetGroup.targetGroupArn, apiTargetGroup.targetGroupArn],
      }),
    );

    // Schedule the sync every 5 minutes
    new Rule(this, "EniSyncSchedule", {
      description: "Periodically sync endpoint ENI IPs to ALB target groups",
      schedule: Schedule.rate(Duration.minutes(5)),
      targets: [new LambdaFunction(eniSyncLambda.lambdaFunction)],
    });

    // ─── Listener + Rules with Transforms ────────────────────────────────────

    const certificateArn =
      props.certificateArn ?? scope.node.tryGetContext("certificateArn");

    if (certificateArn) {
      const certificate = Certificate.fromCertificateArn(
        this,
        "Certificate",
        certificateArn,
      );

      // HTTPS listener: default action serves static SPA from S3
      const httpsListener = this.loadBalancer.addListener("HttpsListener", {
        port: 443,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [certificate],
        defaultAction: ListenerAction.forward([s3TargetGroup]),
      });

      // /api/* rule: forward to API Gateway target group
      httpsListener.addAction("ApiRule", {
        priority: 10,
        conditions: [ListenerCondition.pathPatterns(["/api/*"])],
        action: ListenerAction.forward([apiTargetGroup]),
      });

      // HTTP → HTTPS redirect
      this.loadBalancer.addListener("HttpListener", {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        defaultAction: ListenerAction.redirect({
          protocol: ApplicationProtocol.HTTPS,
          port: "443",
          permanent: true,
        }),
      });
    } else {
      // HTTP-only (dev/test mode)
      const httpListener = this.loadBalancer.addListener("HttpListener", {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        defaultAction: ListenerAction.forward([s3TargetGroup]),
      });

      httpListener.addAction("ApiRule", {
        priority: 10,
        conditions: [ListenerCondition.pathPatterns(["/api/*"])],
        action: ListenerAction.forward([apiTargetGroup]),
      });
    }

    // ─── NOTE: Rule transforms (host-header-rewrite, url-rewrite) ────────────
    // CDK L2 does not yet expose the ALB rule transform API. These must be
    // applied post-deployment via a custom resource or CLI call:
    //
    //   aws elbv2 modify-rule --rule-arn <api-rule-arn> --actions '[...]' \
    //     --transforms '[
    //       {"Type":"host-header-rewrite","HostHeaderRewriteConfig":{"Rewrites":[
    //         {"Regex":"{{^.*$}}","Replace":"{{<apiId>.execute-api.<region>.amazonaws.com}}"}
    //       ]}},
    //       {"Type":"url-rewrite","UrlRewriteConfig":{"Rewrites":[
    //         {"Regex":"{{^/api/(.*)$}}","Replace":"{{/prod/$1}}"}
    //       ]}}
    //     ]'
    //
    // For the SPA rule (default action), the url-rewrite for deep links:
    //   {"Type":"url-rewrite","UrlRewriteConfig":{"Rewrites":[
    //     {"Regex":"{{^/[^.]*$}}","Replace":"{{/index.html}}"}
    //   ]}}
    //
    // And the host-header-rewrite to S3:
    //   {"Type":"host-header-rewrite","HostHeaderRewriteConfig":{"Rewrites":[
    //     {"Regex":"{{^.*$}}","Replace":"{{<bucket>.s3.<region>.amazonaws.com}}"}
    //   ]}}
    //
    // TODO(Phase 2 follow-up): Implement as a CDK custom resource so these are
    // applied automatically during deployment. Tracking as a post-synth-verify
    // item in the runtime checklist.

    // ─── WAF (re-homed to the ALB) ──────────────────────────────────────────

    new Waf(this, "Waf", {
      namespace: props.namespace,
      resourceArn: this.loadBalancer.loadBalancerArn,
      allowListedCidr: props.allowListedCidr,
      kmsKey,
    });

    // ─── Outputs ────────────────────────────────────────────────────────────

    new CfnOutput(this, "AlbDnsName", {
      key: "AlbDnsName",
      value: this.loadBalancer.loadBalancerDnsName,
      description: "Internal ALB DNS name for the Innovation Sandbox UI",
    });

    new CfnOutput(this, "VpcId", {
      key: "VpcId",
      value: this.vpc.vpcId,
      description: "VPC hosting the ALB + S3 front door",
    });
  }
}

/**
 * Builds the frontend application at synth time and returns the dist path
 */
function buildFrontend(frontendPath: string): string {
  const distPath = path.join(frontendPath, "dist");

  if (existsSync(distPath)) {
    rmSync(distPath, { recursive: true });
  }

  try {
    //prettier-ignore
    execSync("npm run build", { // NOSONAR typescript:S4036 - only used in cdk synth process
      cwd: frontendPath,
      stdio: "inherit",
    });

    return distPath;
  } catch (error) {
    throw new Error(`Failed to build frontend: ${error}`);
  }
}
