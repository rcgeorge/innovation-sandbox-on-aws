// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const CreateGovCloudAccountEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    COMMERCIAL_BRIDGE_API_URL: z.string(),
    COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN: z.string(),
    ACCOUNT_TABLE_NAME: z.string(),
    ISB_NAMESPACE: z.string(),
    ISB_EVENT_BUS: z.string(),
    SANDBOX_OU_ID: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
    IDC_ROLE_ARN: z.string(),
    ORG_MGT_ACCOUNT_ID: z.string(),
    IDC_ACCOUNT_ID: z.string(),
    HUB_ACCOUNT_ID: z.string(),
  });

export type CreateGovCloudAccountEnvironment = z.infer<
  typeof CreateGovCloudAccountEnvironmentSchema
>;
