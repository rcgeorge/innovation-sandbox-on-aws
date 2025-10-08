// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CommercialBridgeClient } from "@amzn/innovation-sandbox-commons/isb-services/commercial-bridge-client.js";
import { CommercialBridgeEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/commercial-bridge-environment.js";

/**
 * Create CommercialBridgeClient with appropriate authentication based on environment
 *
 * Supports two authentication modes:
 * 1. API Key (legacy) - If COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN is provided
 * 2. IAM Roles Anywhere (recommended) - If all four ROLES_ANYWHERE variables are provided
 *
 * @param env Environment variables
 * @returns CommercialBridgeClient configured with the appropriate authentication
 */
export function createCommercialBridgeClient(
  env: CommercialBridgeEnvironment,
): CommercialBridgeClient {
  // Check if using IAM Roles Anywhere
  if (
    env.COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN &&
    env.COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN &&
    env.COMMERCIAL_BRIDGE_PROFILE_ARN &&
    env.COMMERCIAL_BRIDGE_ROLE_ARN
  ) {
    return new CommercialBridgeClient(
      env.COMMERCIAL_BRIDGE_API_URL,
      undefined, // No API key
      {
        clientCertSecretArn: env.COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN,
        trustAnchorArn: env.COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN,
        profileArn: env.COMMERCIAL_BRIDGE_PROFILE_ARN,
        roleArn: env.COMMERCIAL_BRIDGE_ROLE_ARN,
      },
    );
  }

  // Fall back to API Key auth
  if (env.COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN) {
    return new CommercialBridgeClient(
      env.COMMERCIAL_BRIDGE_API_URL,
      env.COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN,
    );
  }

  throw new Error(
    "CommercialBridgeClient requires either API Key or IAM Roles Anywhere configuration",
  );
}
