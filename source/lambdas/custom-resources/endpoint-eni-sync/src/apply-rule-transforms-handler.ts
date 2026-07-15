// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CloudFormation custom resource that applies ALB listener-rule transforms
 * (host-header-rewrite, url-rewrite) to the SPA and API rules. CDK L2 does not
 * yet expose the Transforms API, so this handler calls elbv2 ModifyRule
 * directly on Create/Update.
 *
 * Transforms rewrite the request before it is forwarded to the target:
 *  - SPA rule: rewrite Host -> S3 endpoint host; rewrite extensionless paths
 *    -> /index.html for client-side routing deep links.
 *  - API rule: rewrite Host -> API Gateway execute-api host (API GW returns 403
 *    if Host is not its own domain); strip the /api prefix and inject the stage.
 *
 * ResourceProperties (all required on Create/Update):
 *  - SpaRuleArn, S3EndpointHost
 *  - ApiRuleArn, ApiGatewayHost, ApiStage
 */

import {
  ElasticLoadBalancingV2Client,
  ModifyRuleCommand,
  type RuleTransform,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { Logger } from "@aws-lambda-powertools/logger";
import type {
  CdkCustomResourceEvent,
  CdkCustomResourceResponse,
} from "aws-lambda";

const logger = new Logger({ serviceName: "apply-rule-transforms" });
const elbv2 = new ElasticLoadBalancingV2Client({});

function hostRewrite(replaceHost: string): RuleTransform {
  return {
    Type: "host-header-rewrite",
    HostHeaderRewriteConfig: {
      // Match any host and replace with the target host.
      Rewrites: [{ Regex: "^.*$", Replace: replaceHost }],
    },
  };
}

function urlRewrite(regex: string, replace: string): RuleTransform {
  return {
    Type: "url-rewrite",
    UrlRewriteConfig: {
      Rewrites: [{ Regex: regex, Replace: replace }],
    },
  };
}

async function applyTransforms(props: Record<string, string>): Promise<void> {
  const {
    SpaRuleArn,
    S3EndpointHost,
    ApiRuleArn,
    ApiGatewayHost,
    ApiStage,
  } = props;

  if (
    !SpaRuleArn ||
    !S3EndpointHost ||
    !ApiRuleArn ||
    !ApiGatewayHost ||
    !ApiStage
  ) {
    throw new Error(
      "Missing required ResourceProperties: SpaRuleArn, S3EndpointHost, ApiRuleArn, ApiGatewayHost, ApiStage",
    );
  }

  // SPA rule: rewrite Host to S3, and rewrite extensionless paths to
  // /index.html so client-side routing deep links resolve. Requests that do
  // not match the url-rewrite regex (e.g. *.js, *.css) are forwarded unchanged.
  logger.info("Applying SPA rule transforms", { SpaRuleArn, S3EndpointHost });
  await elbv2.send(
    new ModifyRuleCommand({
      RuleArn: SpaRuleArn,
      Transforms: [
        hostRewrite(S3EndpointHost),
        urlRewrite("^/[^.]*$", "/index.html"),
      ],
    }),
  );

  // API rule: rewrite Host to API Gateway, strip /api prefix and inject stage.
  logger.info("Applying API rule transforms", {
    ApiRuleArn,
    ApiGatewayHost,
    ApiStage,
  });
  await elbv2.send(
    new ModifyRuleCommand({
      RuleArn: ApiRuleArn,
      Transforms: [
        hostRewrite(ApiGatewayHost),
        urlRewrite("^/api/(.*)$", `/${ApiStage}/$1`),
      ],
    }),
  );
}

export async function handler(
  event: CdkCustomResourceEvent,
): Promise<CdkCustomResourceResponse> {
  logger.info("Received event", { requestType: event.RequestType });

  if (event.RequestType === "Delete") {
    // The listener rules are deleted with the stack; nothing to undo.
    return { PhysicalResourceId: physicalId(event) };
  }

  await applyTransforms(
    event.ResourceProperties as unknown as Record<string, string>,
  );

  return { PhysicalResourceId: physicalId(event) };
}

function physicalId(event: CdkCustomResourceEvent): string {
  return "PhysicalResourceId" in event && event.PhysicalResourceId
    ? event.PhysicalResourceId
    : `alb-rule-transforms-${event.LogicalResourceId}`;
}
