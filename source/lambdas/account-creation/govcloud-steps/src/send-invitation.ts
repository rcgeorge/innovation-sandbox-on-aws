// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { GovCloudOrgEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/govcloud-org-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

const serviceName = "SendOrganizationInvitation";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: GovCloudOrgEnvironmentSchema,
  moduleName: "send-invitation",
}).handler(sendInvitationHandler);

interface SendInvitationInput {
  govCloudAccountId: string;
  commercialAccountId: string;
  accountName: string;
}

interface SendInvitationOutput {
  govCloudAccountId: string;
  commercialAccountId: string;
  handshakeId: string;
  accountName: string;
}

async function sendInvitationHandler(
  event: SendInvitationInput,
  context: ValidatedEnvironment<any>,
): Promise<SendInvitationOutput> {
  logger.info("Sending organization invitation", { govCloudAccountId: event.govCloudAccountId });

  const orgsService = IsbServices.orgsService(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );

  const invitation = await orgsService.inviteAccountToOrganization(event.govCloudAccountId);

  logger.info("Invitation sent", {
    govCloudAccountId: event.govCloudAccountId,
    handshakeId: invitation.handshakeId,
  });

  return {
    govCloudAccountId: event.govCloudAccountId,
    commercialAccountId: event.commercialAccountId,
    handshakeId: invitation.handshakeId,
    accountName: event.accountName,
  };
}
