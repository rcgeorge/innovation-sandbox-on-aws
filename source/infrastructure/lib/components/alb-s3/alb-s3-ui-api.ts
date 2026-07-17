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
import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { RestApi as ApiGatewayRestApi } from "aws-cdk-lib/aws-apigateway";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import {
  ApplicationListenerRule,
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  IpAddressType,
  ListenerAction,
  ListenerCondition,
  Protocol as ElbProtocol,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
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

import { ApplyRuleTransformsLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/apply-rule-transforms-lambda-environment.js";
import { EndpointEniSyncLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/endpoint-eni-sync-lambda-environment.js";
import { IsbPrivateNetwork } from "@amzn/innovation-sandbox-infrastructure/components/alb-s3/isb-private-network";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbLambdaFunctionCustomResource } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function-custom-resource";
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
   * Shared private networking (VPC + S3/execute-api interface endpoints),
   * created before the RestApi so the API can be made PRIVATE and scoped to the
   * execute-api endpoint.
   */
  network: IsbPrivateNetwork;
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

    // ─── Shared networking (created before the RestApi) ─────────────────────

    this.vpc = props.network.vpc;
    const s3Endpoint = props.network.s3Endpoint;
    const executeApiEndpoint = props.network.executeApiEndpoint;

    // ─── SPA S3 Bucket ──────────────────────────────────────────────────────

    const spaBucket = new Bucket(this, "SpaBucket", {
      removalPolicy: isDevMode(scope)
        ? RemovalPolicy.DESTROY
        : RemovalPolicy.RETAIN,
      // Versioned + DESTROY (dev) means a stack delete/rollback cannot remove
      // the bucket unless its object versions are emptied first, otherwise the
      // stack ends up in ROLLBACK_FAILED. autoDeleteObjects handles that in dev.
      autoDeleteObjects: isDevMode(scope),
      encryption: BucketEncryption.S3_MANAGED, // interface endpoint → no KMS
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      publicReadAccess: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
    });

    // Allow GetObject only for requests arriving through the S3 interface
    // endpoint. Browser requests forwarded by the ALB are anonymous (no SigV4,
    // no service principal), so the principal must be AnyPrincipal ({"AWS":"*"})
    // — a ServicePrincipal("*") ({"Service":"*"}) would match only AWS service
    // callers and deny every asset fetch. The aws:SourceVpce condition (plus the
    // bucket's BlockPublicAccess) keeps this non-public: only traffic through
    // this VPC endpoint is permitted.
    spaBucket.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [new AnyPrincipal()],
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

    // The ALB's target groups are IP-type (interface-endpoint ENIs), which CDK
    // cannot associate with a security group, so it does NOT add any egress from
    // the ALB to the targets — the ALB SG defaults to deny-all-outbound. Without
    // this, the ALB cannot reach the endpoints for health checks OR real
    // traffic (targets time out → permanently unhealthy → 503). Explicitly allow
    // the ALB to reach both interface endpoints on 443.
    this.loadBalancer.connections.allowTo(
      s3Endpoint,
      ec2.Port.tcp(443),
      "ALB → S3 interface endpoint (health checks + traffic)",
    );
    this.loadBalancer.connections.allowTo(
      executeApiEndpoint,
      ec2.Port.tcp(443),
      "ALB → execute-api interface endpoint (health checks + traffic)",
    );

    // ─── Target Groups (IP type — populated by ENI-sync Lambda) ─────────────

    const s3TargetGroup = new ApplicationTargetGroup(this, "S3TargetGroup", {
      vpc: this.vpc,
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      targetType: TargetType.IP,
      healthCheck: {
        path: "/",
        protocol: ElbProtocol.HTTPS,
        // Listener-rule host-header transforms do NOT apply to health checks, so
        // the check reaches the S3 endpoint ENI with a bare-IP Host and S3
        // answers with a 4xx (400/403/404 depending on request). Any HTTP status
        // means the ENI is reachable and serving — which is the only thing this
        // check can verify. A 5xx (endpoint genuinely broken) correctly fails.
        healthyHttpCodes: "200-499",
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
          // As with the S3 group: transforms don't apply to health checks, so
          // execute-api sees a bare-IP Host and returns 403/404. Any HTTP status
          // confirms the endpoint ENI is alive; only a 5xx marks it unhealthy.
          healthyHttpCodes: "200-499",
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
    // RegisterTargets/DeregisterTargets support resource-level scoping to the
    // target groups.
    eniSyncLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "elasticloadbalancing:RegisterTargets",
          "elasticloadbalancing:DeregisterTargets",
        ],
        resources: [s3TargetGroup.targetGroupArn, apiTargetGroup.targetGroupArn],
      }),
    );
    // DescribeTargetHealth (like ELBv2 Describe* actions generally) does NOT
    // support resource-level permissions and must be granted on "*", otherwise
    // IAM reports "no identity-based policy allows the action".
    eniSyncLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["elasticloadbalancing:DescribeTargetHealth"],
        resources: ["*"],
      }),
    );

    // NOTE: a deploy-time Trigger to pre-populate the target groups was
    // intentionally removed. At stack-create the interface-endpoint ENIs are not
    // reliably ready, so a synchronous deploy-time sync is racy and, if made
    // fatal, fails the entire Compute deploy. The scheduled sync below is the
    // authoritative mechanism; the only cost is that the ALB may return 503 for
    // up to the poll interval immediately after a fresh deploy, until the first
    // scheduled run registers the endpoint ENIs.

    // Correct drift on a schedule. There is no native EventBridge event for
    // interface-endpoint ENI IP changes (AZ recovery / scaling), so a short
    // polling interval is the practical mechanism; 2 minutes bounds the window
    // during which a rotated ENI could point at a dead IP (health checks also
    // deregister unreachable targets in the meantime).
    new Rule(this, "EniSyncSchedule", {
      description: "Periodically sync endpoint ENI IPs to ALB target groups",
      schedule: Schedule.rate(Duration.minutes(2)),
      targets: [new LambdaFunction(eniSyncLambda.lambdaFunction)],
    });

    // Alarm if the sync fails repeatedly — it is the only thing keeping the ALB
    // target groups aligned with the live endpoint ENIs, and silent failure
    // means slow blackholing of the front door.
    new Alarm(this, "EniSyncFailureAlarm", {
      alarmDescription:
        "Endpoint ENI-sync Lambda is failing; ALB target groups may drift from the live VPC endpoint ENIs, degrading the UI front door.",
      metric: eniSyncLambda.lambdaFunction.metricErrors({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // ─── Listener + Rules with Transforms ────────────────────────────────────
    //
    // ALB rule transforms cannot be attached to a listener's *default* rule, so
    // both the SPA and API paths are explicit priority rules. The default
    // action returns a fixed 404. The transforms themselves are applied by a
    // custom resource (below) because CDK L2 does not yet expose the transform
    // API.

    const certificateArn =
      props.certificateArn ?? scope.node.tryGetContext("certificateArn");

    // The ALB carries the SAML assertion and the rotated session JWT. Outside
    // dev/test an HTTPS listener is mandatory — refuse to synth an HTTP-only
    // front door that would move those credentials in cleartext.
    if (!certificateArn && !isDevMode(scope)) {
      throw new Error(
        "AlbS3UiApi requires an ACM certificate outside dev mode. Provide " +
          "`certificateArn` (prop or CDK context) so the ALB can serve HTTPS. " +
          "HTTP-only is permitted only when the deployment is in dev mode.",
      );
    }

    const fixed404 = ListenerAction.fixedResponse(404, {
      contentType: "text/plain",
      messageBody: "Not Found",
    });

    let listener;
    if (certificateArn) {
      const certificate = Certificate.fromCertificateArn(
        this,
        "Certificate",
        certificateArn,
      );

      listener = this.loadBalancer.addListener("HttpsListener", {
        port: 443,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [certificate],
        defaultAction: fixed404,
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
      listener = this.loadBalancer.addListener("HttpListener", {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        defaultAction: fixed404,
      });
    }

    // NOTE: ALB security-group ingress is left at the ALB default. The WAF web
    // ACL (allow-listed CIDRs + rate limiting, keyed off the source IP — see
    // below) is the request gate. SG-scoping to allowListedCidr is not applied
    // here because those values arrive as CloudFormation parameter tokens
    // (comma-split at deploy time), which ec2.Peer.ipv4() cannot validate; the
    // load balancer is internal (internetFacing:false) regardless.

    // API rule (higher priority): /api/* → API Gateway target group
    const apiRule = new ApplicationListenerRule(this, "ApiListenerRule", {
      listener,
      priority: 10,
      conditions: [ListenerCondition.pathPatterns(["/api/*"])],
      action: ListenerAction.forward([apiTargetGroup]),
    });

    // SPA rule (catch-all): everything else → S3 target group
    const spaRule = new ApplicationListenerRule(this, "SpaListenerRule", {
      listener,
      priority: 20,
      conditions: [ListenerCondition.pathPatterns(["/*"])],
      action: ListenerAction.forward([s3TargetGroup]),
    });

    // ─── Rule Transforms (applied via custom resource) ───────────────────────
    // CDK L2 does not expose ALB rule transforms, so a custom resource calls
    // elbv2 ModifyRule. See apply-rule-transforms-handler.ts.
    const region = Stack.of(this).region;
    const s3EndpointHost = `${spaBucket.bucketName}.s3.${region}.${Stack.of(this).urlSuffix}`;
    const apiGatewayHost = `${props.restApi.restApiId}.execute-api.${region}.${Stack.of(this).urlSuffix}`;

    const transformsCr = new IsbLambdaFunctionCustomResource(
      this,
      "ApplyRuleTransforms",
      {
        description:
          "Applies ALB host-header-rewrite and url-rewrite transforms to the SPA and API listener rules",
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
          "apply-rule-transforms-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        timeout: Duration.seconds(30),
        environment: {},
        envSchema: ApplyRuleTransformsLambdaEnvironmentSchema,
        customResourceType: "Custom::AlbRuleTransforms",
        customResourceProperties: {
          SpaRuleArn: spaRule.listenerRuleArn,
          S3EndpointHost: s3EndpointHost,
          ApiRuleArn: apiRule.listenerRuleArn,
          ApiGatewayHost: apiGatewayHost,
          ApiStage: props.restApi.deploymentStage.stageName,
        },
      },
    );

    transformsCr.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["elasticloadbalancing:ModifyRule"],
        resources: [spaRule.listenerRuleArn, apiRule.listenerRuleArn],
      }),
    );

    // ─── WAF (re-homed to the ALB) ──────────────────────────────────────────

    new Waf(this, "Waf", {
      namespace: props.namespace,
      resourceArn: this.loadBalancer.loadBalancerArn,
      allowListedCidr: props.allowListedCidr,
      kmsKey,
      // WAF sits directly on the ALB (no CloudFront injecting a trusted
      // X-Forwarded-For), so key the allow-list and rate limit off the
      // connection source IP.
      useSourceIp: true,
      // Distinct log-group name so it doesn't collide with the private API
      // Gateway WAF's log group (both live in the Compute stack in alb-s3 mode).
      logGroupSuffix: "alb",
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
