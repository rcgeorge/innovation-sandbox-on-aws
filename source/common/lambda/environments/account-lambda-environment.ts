// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const AccountLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    APP_CONFIG_APPLICATION_ID: z.string(),
    APP_CONFIG_PROFILE_ID: z.string(),
    APP_CONFIG_ENVIRONMENT_ID: z.string(),
    AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: z.string(),
    ACCOUNT_TABLE_NAME: z.string(),
    ISB_NAMESPACE: z.string(),
    LEASE_TABLE_NAME: z.string(),
    ISB_EVENT_BUS: z.string(),
    SANDBOX_OU_ID: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
    IDC_ROLE_ARN: z.string(),
    ORG_MGT_ACCOUNT_ID: z.string(),
    IDC_ACCOUNT_ID: z.string(),
    HUB_ACCOUNT_ID: z.string(),
    COMMERCIAL_BRIDGE_API_URL: z.string().optional(),
    COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN: z.string().optional(),
    // IAM Roles Anywhere configuration (optional)
    COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN: z.string().optional(),
    COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN: z.string().optional(),
    COMMERCIAL_BRIDGE_PROFILE_ARN: z.string().optional(),
    COMMERCIAL_BRIDGE_ROLE_ARN: z.string().optional(),
    GOVCLOUD_CREATION_STEP_FUNCTION_ARN: z.string().optional(),
  });

export type AccountLambdaEnvironment = z.infer<
  typeof AccountLambdaEnvironmentSchema
>;
