// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CommercialBridgeClient } from "@amzn/innovation-sandbox-commons/isb-services/cost/commercial-bridge-client.js";
import {
  CommercialBridgeEnvironment,
  isCommercialBridgeConfigured,
} from "@amzn/innovation-sandbox-commons/lambda/environments/commercial-bridge-environment.js";

/**
 * Build a CommercialBridgeClient from environment configuration. Requires the
 * full IAM Roles Anywhere set (validated by isCommercialBridgeConfigured).
 */
export function createCommercialBridgeClient(
  env: CommercialBridgeEnvironment,
): CommercialBridgeClient {
  if (!isCommercialBridgeConfigured(env)) {
    throw new Error(
      "CommercialBridgeClient requires COMMERCIAL_BRIDGE_API_URL and the full " +
        "IAM Roles Anywhere configuration (client cert, trust anchor, profile, role ARNs).",
    );
  }

  return new CommercialBridgeClient(env.COMMERCIAL_BRIDGE_API_URL!, {
    clientCertSecretArn: env.COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN!,
    trustAnchorArn: env.COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN!,
    profileArn: env.COMMERCIAL_BRIDGE_PROFILE_ARN!,
    roleArn: env.COMMERCIAL_BRIDGE_ROLE_ARN!,
  });
}
