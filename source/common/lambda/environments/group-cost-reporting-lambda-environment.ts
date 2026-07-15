// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { CommercialBridgeEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/commercial-bridge-environment.js";

export const GroupCostReportingLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.merge(CommercialBridgeEnvironmentSchema).extend({
    LEASE_TABLE_NAME: z.string(),
    // Used by the unified cost service (GovCloud account mapping). Only set in
    // bridge mode; optional so commercial deployments validate.
    ACCOUNT_TABLE_NAME: z.string().optional(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
    REPORT_BUCKET_NAME: z.string(),
    ISB_NAMESPACE: z.string(),
    ISB_EVENT_BUS: z.string(),
  });

export type GroupCostReportingLambdaEnvironment = z.infer<
  typeof GroupCostReportingLambdaEnvironmentSchema
>;
