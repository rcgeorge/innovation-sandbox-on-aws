// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Construct } from "constructs";

/**
 * Reads a boolean CDK context flag. Context values arrive as strings when
 * passed via `cdk -c key=value`, so only the literal boolean true or the
 * string "true" are treated as enabled; everything else (including unset and
 * "false") is disabled. This keeps commercial deployments on their default
 * behavior with byte-identical synth output.
 */
function getBooleanContext(scope: Construct, key: string): boolean {
  const value = scope.node.tryGetContext(key);
  return value === true || value === "true";
}

/**
 * Synth-time signal that the solution is being deployed into an AWS GovCloud
 * (US) partition. Use ONLY for CloudFormation-schema differences that a runtime
 * `AWS::Partition` token cannot express (e.g. a resource property that does not
 * exist in the GovCloud resource specification). For ARN partitions, prefer
 * `Stack.of(scope).partition` so no flag is required.
 */
export function isGovCloud(scope: Construct): boolean {
  return getBooleanContext(scope, "isGovCloud");
}

/**
 * The web UI hosting front door. "cloudfront" (default) keeps the S3 +
 * CloudFront architecture; "alb-s3" selects the private ALB + S3 front door for
 * partitions/regions without CloudFront.
 */
export function getHostingMode(scope: Construct): "cloudfront" | "alb-s3" {
  return scope.node.tryGetContext("hostingMode") === "alb-s3"
    ? "alb-s3"
    : "cloudfront";
}

/**
 * Whether the cross-partition commercial bridge cost service wiring is enabled.
 */
export function isCommercialBridgeEnabled(scope: Construct): boolean {
  return getBooleanContext(scope, "enableCommercialBridge");
}

/**
 * Whether the optional cross-partition GovCloud account provisioning stack is
 * enabled.
 */
export function isGovCloudAccountProvisioningEnabled(
  scope: Construct,
): boolean {
  return getBooleanContext(scope, "enableGovCloudAccountProvisioning");
}
