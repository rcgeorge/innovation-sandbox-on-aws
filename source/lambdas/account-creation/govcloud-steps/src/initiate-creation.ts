// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import { CommercialBridgeClient } from "@amzn/innovation-sandbox-commons/isb-services/commercial-bridge-client.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { CommercialBridgeEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/commercial-bridge-environment.js";

const serviceName = "InitiateAccountCreation";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: CommercialBridgeEnvironmentSchema,
  moduleName: "initiate-creation",
}).handler(initiateCreationHandler);

interface InitiateCreationInput {
  accountName: string;
  email: string;
}

interface InitiateCreationOutput {
  requestId: string;
  status: string;
  accountName: string;
  email: string;
}

async function initiateCreationHandler(
  event: InitiateCreationInput,
  context: ValidatedEnvironment<any>,
): Promise<InitiateCreationOutput> {
  logger.info("Initiating GovCloud account creation", event);

  const commercialBridge = new CommercialBridgeClient(
    context.env.COMMERCIAL_BRIDGE_API_URL,
    context.env.COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN,
  );

  const result = await commercialBridge.createGovCloudAccount({
    accountName: event.accountName,
    email: event.email,
  });

  logger.info("Account creation initiated", { requestId: result.requestId });

  return {
    requestId: result.requestId,
    status: result.status,
    accountName: event.accountName,
    email: event.email,
  };
}
