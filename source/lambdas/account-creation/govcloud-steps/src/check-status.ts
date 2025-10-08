// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import { createCommercialBridgeClient } from "@amzn/innovation-sandbox-commons/isb-services/commercial-bridge-factory.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { CommercialBridgeEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/commercial-bridge-environment.js";

const serviceName = "CheckAccountStatus";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: CommercialBridgeEnvironmentSchema,
  moduleName: "check-status",
}).handler(checkStatusHandler);

interface CheckStatusInput {
  requestId: string;
  accountName: string;
  email: string;
}

interface CheckStatusOutput {
  requestId: string;
  status: string;
  govCloudAccountId?: string;
  commercialAccountId?: string;
  accountName: string;
  email: string;
  message?: string;
}

async function checkStatusHandler(
  event: CheckStatusInput,
  context: ValidatedEnvironment<any>,
): Promise<CheckStatusOutput> {
  logger.info("Checking account creation status", { requestId: event.requestId });

  const commercialBridge = createCommercialBridgeClient(context.env);

  const result = await commercialBridge.getGovCloudAccountStatus(event.requestId);

  logger.info("Account status retrieved", {
    requestId: event.requestId,
    status: result.status,
    govCloudAccountId: result.govCloudAccountId,
  });

  return {
    requestId: event.requestId,
    status: result.status,
    govCloudAccountId: result.govCloudAccountId,
    commercialAccountId: result.commercialAccountId,
    accountName: event.accountName,
    email: event.email,
    message: result.message,
  };
}
