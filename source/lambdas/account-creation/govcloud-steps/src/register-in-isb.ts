// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { RegisterISBEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/register-isb-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import {
  fromTemporaryIsbIdcCredentials,
  fromTemporaryIsbOrgManagementCredentials,
} from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

const serviceName = "RegisterInISB";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: RegisterISBEnvironmentSchema,
  moduleName: "register-in-isb",
}).handler(registerInISBHandler);

interface RegisterInISBInput {
  govCloudAccountId: string;
  commercialAccountId: string;
  accountName: string;
}

interface RegisterInISBOutput {
  govCloudAccountId: string;
  commercialAccountId: string;
  status: string;
  message: string;
}

async function registerInISBHandler(
  event: RegisterInISBInput,
  context: ValidatedEnvironment<any>,
): Promise<RegisterInISBOutput> {
  logger.info("Registering account in Innovation Sandbox", {
    govCloudAccountId: event.govCloudAccountId,
  });

  const accountStore = IsbServices.sandboxAccountStore(context.env);

  // Check if account is already registered
  const existingAccountResult = await accountStore.get(event.govCloudAccountId);

  if (existingAccountResult.result) {
    logger.info("Account already registered, updating commercial account mapping", {
      govCloudAccountId: event.govCloudAccountId,
    });

    const existingAccount = existingAccountResult.result;

    // Update with commercial account ID if not already set
    if (!existingAccount.commercialLinkedAccountId) {
      await accountStore.put({
        ...existingAccount,
        commercialLinkedAccountId: event.commercialAccountId,
      });
    }

    return {
      govCloudAccountId: event.govCloudAccountId,
      commercialAccountId: event.commercialAccountId,
      status: "SUCCESS",
      message: "GovCloud account was already registered",
    };
  }

  const orgsService = IsbServices.orgsService(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );

  const registeredAccount = await InnovationSandbox.registerAccount(
    event.govCloudAccountId,
    {
      logger,
      tracer,
      eventBridgeClient: IsbServices.isbEventBridge(context.env),
      orgsService,
      idcService: IsbServices.idcService(
        context.env,
        fromTemporaryIsbIdcCredentials(context.env),
      ),
    },
  );

  // Store commercial account mapping
  await accountStore.put({
    ...registeredAccount,
    commercialLinkedAccountId: event.commercialAccountId,
  });

  logger.info("Account registered successfully", {
    govCloudAccountId: event.govCloudAccountId,
    commercialAccountId: event.commercialAccountId,
  });

  return {
    govCloudAccountId: event.govCloudAccountId,
    commercialAccountId: event.commercialAccountId,
    status: "SUCCESS",
    message: "GovCloud account created, joined organization, and registered successfully",
  };
}
