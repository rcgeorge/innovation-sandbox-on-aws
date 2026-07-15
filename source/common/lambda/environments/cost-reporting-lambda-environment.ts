// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { CommercialBridgeEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/commercial-bridge-environment.js";

export const CostReportingLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.merge(CommercialBridgeEnvironmentSchema).extend({
    ACCOUNT_TABLE_NAME: z.string(),
    ISB_NAMESPACE: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
    ISB_TAG_NAME: z.string(),
    ISB_TAG_VALUE: z.string(),
    IDC_ACCOUNT_ID: z.string(),
    ORG_MGT_ACCOUNT_ID: z.string(),
    HUB_ACCOUNT_ID: z.string(),
  });

export type CostReportingLambdaEnvironment = z.infer<
  typeof CostReportingLambdaEnvironmentSchema
>;
