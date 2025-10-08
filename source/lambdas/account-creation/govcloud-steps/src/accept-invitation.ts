// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { GovCloudOrgEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/govcloud-org-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

const serviceName = "AcceptOrganizationInvitation";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: GovCloudOrgEnvironmentSchema,
  moduleName: "accept-invitation",
}).handler(acceptInvitationHandler);

interface AcceptInvitationInput {
  govCloudAccountId: string;
  commercialAccountId: string;
  handshakeId: string;
  accountName: string;
}

interface AcceptInvitationOutput {
  govCloudAccountId: string;
  commercialAccountId: string;
  accountName: string;
}

async function acceptInvitationHandler(
  event: AcceptInvitationInput,
  context: ValidatedEnvironment<any>,
): Promise<AcceptInvitationOutput> {
  logger.info("Accepting organization invitation", {
    govCloudAccountId: event.govCloudAccountId,
    handshakeId: event.handshakeId,
  });

  // If handshake ID is placeholder, account is already joined
  if (event.handshakeId === "already-joined") {
    logger.info("Account already in organization, skipping acceptance", {
      govCloudAccountId: event.govCloudAccountId,
    });

    return {
      govCloudAccountId: event.govCloudAccountId,
      commercialAccountId: event.commercialAccountId,
      accountName: event.accountName,
    };
  }

  const orgsService = IsbServices.orgsService(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );

  try {
    await orgsService.acceptHandshakeAsAccount(
      event.govCloudAccountId,
      event.handshakeId,
    );

    logger.info("Invitation accepted", {
      govCloudAccountId: event.govCloudAccountId,
    });
  } catch (error: any) {
    // If account is already in the organization, treat as success
    if (error.name === "HandshakeAlreadyInStateException" ||
        error.message?.includes("already a member")) {
      logger.info("Account already in organization, continuing", {
        govCloudAccountId: event.govCloudAccountId,
      });
    } else {
      throw error;
    }
  }

  return {
    govCloudAccountId: event.govCloudAccountId,
    commercialAccountId: event.commercialAccountId,
    accountName: event.accountName,
  };
}
