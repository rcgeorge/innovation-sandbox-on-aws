// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const EndpointEniSyncLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    /**
     * Comma-separated list of VPC Endpoint IDs whose network interface IPs
     * should be synced into ALB target groups. Format:
     *   vpce-abc123:tg-arn-1,vpce-def456:tg-arn-2
     * Each pair maps one interface endpoint to one IP target group.
     */
    ENDPOINT_TARGET_GROUP_MAPPINGS: z.string(),
  });

export type EndpointEniSyncLambdaEnvironment = z.infer<
  typeof EndpointEniSyncLambdaEnvironmentSchema
>;
