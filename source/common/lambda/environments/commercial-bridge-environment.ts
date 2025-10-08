// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const CommercialBridgeEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    COMMERCIAL_BRIDGE_API_URL: z.string(),
    COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN: z.string(),
  });

export type CommercialBridgeEnvironment = z.infer<
  typeof CommercialBridgeEnvironmentSchema
>;
