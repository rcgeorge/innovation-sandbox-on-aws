// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

/**
 * Commercial Bridge environment schema supporting two authentication modes:
 * 1. API Key (legacy) - Requires COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN
 * 2. IAM Roles Anywhere (recommended) - Requires all four ROLES_ANYWHERE variables
 */
const CommercialBridgeBaseSchema = BaseLambdaEnvironmentSchema.extend({
  COMMERCIAL_BRIDGE_API_URL: z.string().url(),
  // API Key auth (legacy)
  COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN: z.string().optional(),
  // IAM Roles Anywhere auth (recommended)
  COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN: z.string().optional(),
  COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN: z.string().optional(),
  COMMERCIAL_BRIDGE_PROFILE_ARN: z.string().optional(),
  COMMERCIAL_BRIDGE_ROLE_ARN: z.string().optional(),
});

export const CommercialBridgeEnvironmentSchema =
  CommercialBridgeBaseSchema.refine(
    (data) => {
      // Must have either API key OR all IAM Roles Anywhere fields
      const hasApiKey = !!data.COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN;
      const hasRolesAnywhere =
        !!data.COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN &&
        !!data.COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN &&
        !!data.COMMERCIAL_BRIDGE_PROFILE_ARN &&
        !!data.COMMERCIAL_BRIDGE_ROLE_ARN;

      return hasApiKey || hasRolesAnywhere;
    },
    {
      message:
        "Either COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN (API Key auth) or all four IAM Roles Anywhere variables " +
        "(COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN, COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN, COMMERCIAL_BRIDGE_PROFILE_ARN, COMMERCIAL_BRIDGE_ROLE_ARN) must be provided",
    },
  );

export type CommercialBridgeEnvironment = z.infer<
  typeof CommercialBridgeBaseSchema
>;
