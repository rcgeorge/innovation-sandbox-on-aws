// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Configuration for calling the commercial bridge API from a GovCloud Lambda.
 * Authentication is IAM Roles Anywhere only (certificate-based SigV4); the
 * legacy API-key mode is intentionally not supported.
 *
 * All fields are optional at the schema level so that commercial deployments,
 * which never set them, validate cleanly. The cost-service factory treats the
 * bridge as enabled only when the full set is present (see
 * isCommercialBridgeConfigured).
 */
export const CommercialBridgeEnvironmentSchema = z.object({
  COMMERCIAL_BRIDGE_API_URL: z.string().optional(),
  COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN: z.string().optional(),
  COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN: z.string().optional(),
  COMMERCIAL_BRIDGE_PROFILE_ARN: z.string().optional(),
  COMMERCIAL_BRIDGE_ROLE_ARN: z.string().optional(),
  // Comma-separated GovCloud regions to query costs for, e.g.
  // "us-gov-east-1,us-gov-west-1".
  COMMERCIAL_BRIDGE_GOVCLOUD_REGIONS: z.string().optional(),
});

export type CommercialBridgeEnvironment = z.infer<
  typeof CommercialBridgeEnvironmentSchema
>;

/**
 * True when the full IAM Roles Anywhere configuration is present, i.e. the
 * commercial bridge cost service should be used instead of direct Cost Explorer.
 */
export function isCommercialBridgeConfigured(
  env: CommercialBridgeEnvironment,
): boolean {
  return Boolean(
    env.COMMERCIAL_BRIDGE_API_URL &&
      env.COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN &&
      env.COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN &&
      env.COMMERCIAL_BRIDGE_PROFILE_ARN &&
      env.COMMERCIAL_BRIDGE_ROLE_ARN,
  );
}
