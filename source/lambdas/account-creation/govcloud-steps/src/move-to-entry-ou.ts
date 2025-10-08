// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { GovCloudOrgEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/govcloud-org-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

const serviceName = "MoveToEntryOU";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: GovCloudOrgEnvironmentSchema,
  moduleName: "move-to-entry-ou",
}).handler(moveToEntryOUHandler);

interface MoveToEntryOUInput {
  govCloudAccountId: string;
  commercialAccountId: string;
  accountName: string;
}

interface MoveToEntryOUOutput {
  govCloudAccountId: string;
  commercialAccountId: string;
  accountName: string;
}

async function moveToEntryOUHandler(
  event: MoveToEntryOUInput,
  context: ValidatedEnvironment<any>,
): Promise<MoveToEntryOUOutput> {
  logger.info("Moving account to Entry OU", { govCloudAccountId: event.govCloudAccountId });

  const orgsService = IsbServices.orgsService(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );

  await orgsService.moveAccountToEntryOu(event.govCloudAccountId);

  logger.info("Account moved to Entry OU", { govCloudAccountId: event.govCloudAccountId });

  return {
    govCloudAccountId: event.govCloudAccountId,
    commercialAccountId: event.commercialAccountId,
    accountName: event.accountName,
  };
}
