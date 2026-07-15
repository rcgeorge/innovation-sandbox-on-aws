// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Context, EventBridgeEvent } from "aws-lambda";

import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  CostReportingLambdaEnvironment,
  CostReportingLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/cost-reporting-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { DateTime } from "luxon";

const serviceName = "CostReporting";
const tracer = new Tracer();
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: CostReportingLambdaEnvironmentSchema,
  moduleName: "cost-reporting",
}).handler(scanAccounts);

export async function scanAccounts(
  _event: EventBridgeEvent<string, unknown>,
  context: Context & ValidatedEnvironment<CostReportingLambdaEnvironment>,
) {
  logger.debug(`Running last month's cost report on ${DateTime.now().toISO()}`);
  const accountStore = IsbServices.sandboxAccountStore(context.env);
  const costExplorerService = IsbServices.costService(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );

  const accounts = await collect(
    stream(accountStore, accountStore.findAll, {}),
  );
  const accountsWithStartDates = Object.fromEntries(
    accounts.map((account) => [
      account.awsAccountId,
      account.meta?.createdTime
        ? DateTime.fromISO(account.meta?.createdTime, { zone: "utc" })
        : now(),
    ]),
  ) as Record<string, DateTime>;
  logger.debug("accountsWithStartDates", { accountsWithStartDates });
  const currentDateTime = now();
  const startOfLastMonth = currentDateTime
    .minus({ months: 1 })
    .startOf("month");
  const endOfLastMonth = currentDateTime.minus({ months: 1 }).endOf("month");

  const lastMonthCostReport = await costExplorerService.getCostForRange(
    startOfLastMonth,
    endOfLastMonth,
    accountsWithStartDates,
  );
  const solutionAccounts = Array.from(
    new Set([
      context.env.IDC_ACCOUNT_ID,
      context.env.ORG_MGT_ACCOUNT_ID,
      context.env.HUB_ACCOUNT_ID,
    ]),
  );
  solutionAccounts.push(...accounts.map((account) => account.awsAccountId));
  logger.debug("solutionAccounts", { solutionAccounts });
  const solutionAccountsWithDates = Object.fromEntries(
    solutionAccounts.map((account) => [account, startOfLastMonth]),
  ) as Record<string, DateTime>;

  const isbTag = {
    tagName: context.env.ISB_TAG_NAME,
    tagValues: [context.env.ISB_TAG_VALUE],
  };
  const lastMonthSolutionCostReport = await costExplorerService.getCostForRange(
    startOfLastMonth,
    endOfLastMonth,
    solutionAccountsWithDates,
    isbTag,
  );
  logger.info("Total cost of sandbox account last month", {
    logDetailType: "CostReporting",
    startDate: startOfLastMonth.toISO(),
    endDate: endOfLastMonth.toISO(),
    sandboxAccountsCost: lastMonthCostReport.totalCost(),
    solutionOperatingCost: lastMonthSolutionCostReport.totalCost(),
    numAccounts: accounts.length,
  } satisfies SubscribableLog);
}
