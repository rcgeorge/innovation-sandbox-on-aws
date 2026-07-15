// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

import { isCommercialBridgeEnabled } from "@amzn/innovation-sandbox-infrastructure/helpers/govcloud-mode";

/**
 * Reads commercial-bridge configuration from CDK context. All values are
 * supplied via `.env` / `-c` when enableCommercialBridge is set (GovCloud).
 * When the bridge is disabled (commercial), returns undefined and adds nothing
 * to the lambda — so commercial synth output is unchanged.
 */
export interface CommercialBridgeConfig {
  apiUrl: string;
  clientCertSecretArn: string;
  trustAnchorArn: string;
  profileArn: string;
  roleArn: string;
  govCloudRegions: string;
}

function readConfig(scope: Construct): CommercialBridgeConfig | undefined {
  if (!isCommercialBridgeEnabled(scope)) {
    return undefined;
  }
  const ctx = (key: string): string => {
    const value = scope.node.tryGetContext(key);
    if (!value) {
      throw new Error(
        `enableCommercialBridge is set but required context "${key}" is missing. ` +
          `Provide it via .env / -c.`,
      );
    }
    return value;
  };

  return {
    apiUrl: ctx("commercialBridgeApiUrl"),
    clientCertSecretArn: ctx("commercialBridgeClientCertSecretArn"),
    trustAnchorArn: ctx("commercialBridgeTrustAnchorArn"),
    profileArn: ctx("commercialBridgeProfileArn"),
    roleArn: ctx("commercialBridgeRoleArn"),
    govCloudRegions: ctx("commercialBridgeGovCloudRegions"),
  };
}

/**
 * Environment variables to add to a cost-consuming lambda for commercial bridge
 * support. Empty object when the bridge is disabled (commercial), so the
 * lambda's environment — and thus synth output — is unchanged.
 */
export function commercialBridgeEnv(
  scope: Construct,
): Record<string, string> {
  const config = readConfig(scope);
  if (!config) {
    return {};
  }
  return {
    COMMERCIAL_BRIDGE_API_URL: config.apiUrl,
    COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN: config.clientCertSecretArn,
    COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN: config.trustAnchorArn,
    COMMERCIAL_BRIDGE_PROFILE_ARN: config.profileArn,
    COMMERCIAL_BRIDGE_ROLE_ARN: config.roleArn,
    COMMERCIAL_BRIDGE_GOVCLOUD_REGIONS: config.govCloudRegions,
  };
}

/**
 * The account-table env var, added only in bridge mode (GovCloud). The cost
 * service needs the account table to map GovCloud → commercial accounts. Empty
 * in commercial so the lambda environment — and synth output — is unchanged.
 */
export function commercialBridgeAccountEnv(
  scope: Construct,
  accountTableName: string,
): Record<string, string> {
  return isCommercialBridgeEnabled(scope)
    ? { ACCOUNT_TABLE_NAME: accountTableName }
    : {};
}

/**
 * Grant the lambda permission to read the client-certificate secret used for
 * IAM Roles Anywhere. No-op when the bridge is disabled (commercial).
 */
export function grantCommercialBridgeAccess(
  scope: Construct,
  lambdaFunction: IFunction,
): void {
  const config = readConfig(scope);
  if (!config) {
    return;
  }
  lambdaFunction.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["secretsmanager:GetSecretValue"],
      resources: [config.clientCertSecretArn],
    }),
  );
}
