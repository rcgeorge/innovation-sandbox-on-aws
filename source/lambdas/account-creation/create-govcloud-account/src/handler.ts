// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { CommercialBridgeClient } from "@amzn/innovation-sandbox-commons/isb-services/commercial-bridge-client.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  CreateGovCloudAccountEnvironment,
  CreateGovCloudAccountEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/create-govcloud-account-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import {
  fromTemporaryIsbIdcCredentials,
  fromTemporaryIsbOrgManagementCredentials,
} from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

const serviceName = "CreateGovCloudAccount";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: CreateGovCloudAccountEnvironmentSchema,
  moduleName: "create-govcloud-account",
}).handler(createGovCloudAccountHandler);

interface CreateGovCloudAccountEvent {
  accountName: string;
  email: string;
}

interface CreateGovCloudAccountResult {
  govCloudAccountId: string;
  commercialAccountId: string;
  status: string;
  message: string;
}

async function createGovCloudAccountHandler(
  event: CreateGovCloudAccountEvent,
  context: ValidatedEnvironment<CreateGovCloudAccountEnvironment>,
): Promise<CreateGovCloudAccountResult> {
  const { accountName, email } = event;

  logger.info("Starting GovCloud account creation", { accountName, email });

  const commercialBridge = new CommercialBridgeClient(
    context.env.COMMERCIAL_BRIDGE_API_URL,
    context.env.COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN,
  );

  // Step 1: Create account via commercial bridge
  logger.info("Step 1: Creating account via commercial bridge");
  const createResponse = await commercialBridge.createGovCloudAccount({
    accountName,
    email,
    roleName: "OrganizationAccountAccessRole",
  });

  logger.info("Account creation initiated", { requestId: createResponse.requestId });

  // Step 2: Poll for account creation completion
  logger.info("Step 2: Polling for account creation completion");
  let accountInfo: { govCloudAccountId: string; commercialAccountId: string } | null = null;
  const maxAttempts = 360; // 30 minutes

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const status = await commercialBridge.getGovCloudAccountStatus(createResponse.requestId);

    if (status.status === "SUCCEEDED" && status.govCloudAccountId && status.commercialAccountId) {
      accountInfo = {
        govCloudAccountId: status.govCloudAccountId,
        commercialAccountId: status.commercialAccountId,
      };
      logger.info("Account creation completed", accountInfo);
      break;
    } else if (status.status === "FAILED") {
      throw new Error(`Account creation failed: ${status.message}`);
    }

    if (i % 12 === 0) {
      // Log every minute
      logger.info("Still waiting for account creation", { attempt: i + 1, status: status.status });
    }
  }

  if (!accountInfo) {
    throw new Error("Account creation timed out after 30 minutes");
  }

  // Step 3: Send invitation from GovCloud org
  logger.info("Step 3: Sending organization invitation");
  const orgsService = IsbServices.orgsService(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );

  const invitation = await orgsService.inviteAccountToOrganization(accountInfo.govCloudAccountId);
  logger.info("Invitation sent", { handshakeId: invitation.handshakeId });

  // Step 4: Accept invitation from new account
  logger.info("Step 4: Accepting invitation");
  await orgsService.acceptHandshakeAsAccount(
    accountInfo.govCloudAccountId,
    invitation.handshakeId,
  );
  logger.info("Invitation accepted");

  // Step 5: Move account to Entry OU
  logger.info("Step 5: Moving account to Entry OU");
  await orgsService.moveAccountToEntryOu(accountInfo.govCloudAccountId);
  logger.info("Account moved to Entry OU");

  // Step 6: Wait for StackSets deployment
  logger.info("Step 6: Waiting for StackSets to deploy SandboxAccountRole (2 minutes)");
  await new Promise((resolve) => setTimeout(resolve, 120000));

  // Step 7: Register account in Innovation Sandbox
  logger.info("Step 7: Registering account in Innovation Sandbox");
  const registeredAccount = await InnovationSandbox.registerAccount(
    accountInfo.govCloudAccountId,
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

  // Step 8: Store commercial account mapping
  logger.info("Step 8: Storing commercial account mapping");
  const accountStore = IsbServices.sandboxAccountStore(context.env);
  await accountStore.put({
    ...registeredAccount,
    commercialLinkedAccountId: accountInfo.commercialAccountId,
  });

  logger.info("GovCloud account creation completed successfully", {
    govCloudAccountId: accountInfo.govCloudAccountId,
    commercialAccountId: accountInfo.commercialAccountId,
  });

  return {
    govCloudAccountId: accountInfo.govCloudAccountId,
    commercialAccountId: accountInfo.commercialAccountId,
    status: "SUCCESS",
    message: "GovCloud account created, joined organization, and registered successfully",
  };
}
