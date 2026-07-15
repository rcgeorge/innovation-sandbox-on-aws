// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

/**
 * The apply-rule-transforms custom resource receives all inputs via
 * CloudFormation ResourceProperties (rule ARNs, hosts, stage), so it needs no
 * additional environment variables beyond the base set.
 */
export const ApplyRuleTransformsLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({});

export type ApplyRuleTransformsLambdaEnvironment = z.infer<
  typeof ApplyRuleTransformsLambdaEnvironmentSchema
>;
