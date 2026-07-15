// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { CommercialBridgeEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/commercial-bridge-environment.js";

export const LeaseMonitoringEnvironmentSchema = BaseLambdaEnvironmentSchema.merge(
  CommercialBridgeEnvironmentSchema,
).extend({
  ISB_EVENT_BUS: z.string(),
  LEASE_TABLE_NAME: z.string(),
  // Used by the unified cost service to map GovCloud → commercial accounts.
  // Only set in GovCloud (commercial bridge) mode; optional so commercial
  // deployments — which do not set it — validate.
  ACCOUNT_TABLE_NAME: z.string().optional(),
  ISB_NAMESPACE: z.string(),
  INTERMEDIATE_ROLE_ARN: z.string(),
  ORG_MGT_ROLE_ARN: z.string(),
});

export type LeaseMonitoringEnvironment = z.infer<
  typeof LeaseMonitoringEnvironmentSchema
>;
