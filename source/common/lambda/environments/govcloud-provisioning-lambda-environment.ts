// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { CommercialBridgeEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/commercial-bridge-environment.js";

export const GovCloudProvisioningLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.merge(CommercialBridgeEnvironmentSchema).extend({
    ISB_NAMESPACE: z.string(),
    ACCOUNT_TABLE_NAME: z.string(),
    ACCOUNT_POOL_CONFIG_PARAM_ARN: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
    // The GovCloud region whose Organizations service issues/accepts invites.
    GOVCLOUD_HOME_REGION: z.string(),
  });

export type GovCloudProvisioningLambdaEnvironment = z.infer<
  typeof GovCloudProvisioningLambdaEnvironmentSchema
>;
