// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { DateTime } from "luxon";

import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import { AccountsCostReport } from "@amzn/innovation-sandbox-commons/isb-services/cost/accounts-cost-report.js";
import {
  CommercialBridgeAccountMappingNotFoundError,
  CommercialBridgeClient,
} from "@amzn/innovation-sandbox-commons/isb-services/cost/commercial-bridge-client.js";
import { createCommercialBridgeClient } from "@amzn/innovation-sandbox-commons/isb-services/cost/commercial-bridge-factory.js";
import { ICostService } from "@amzn/innovation-sandbox-commons/isb-services/cost/cost-service.js";
import { CommercialBridgeEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/commercial-bridge-environment.js";

const logger = new Logger({ serviceName: "CommercialBridgeCostService" });

export interface CommercialBridgeCostServiceConfig {
  commercialBridgeEnv: CommercialBridgeEnvironment;
  govCloudRegions: string[];
  sandboxAccountStore: SandboxAccountStore;
}

/**
 * ICostService implementation for GovCloud. GovCloud has no Cost Explorer API;
 * GovCloud usage is billed to a paired commercial (aws partition) account. This
 * service proxies cost queries to a commercial bridge API, aggregating each
 * GovCloud account's cost across the configured GovCloud regions and keying the
 * result by the GovCloud account id so downstream lease/budget logic is
 * unchanged.
 *
 * Note: the commercial bridge queries Cost Explorer at DAILY/MONTHLY
 * granularity only — HOURLY requests are downgraded to DAILY. Cost-allocation
 * tag filtering is not supported cross-partition and is logged and ignored.
 */
export class CommercialBridgeCostService implements ICostService {
  private readonly client: CommercialBridgeClient;

  constructor(private readonly config: CommercialBridgeCostServiceConfig) {
    this.client = createCommercialBridgeClient(config.commercialBridgeEnv);
  }

  async getCostForLeases(
    accountsWithStartDates: Record<string, DateTime>,
    end: DateTime,
    _granularity: "DAILY" | "HOURLY" = "DAILY",
  ): Promise<AccountsCostReport> {
    const report = new AccountsCostReport();
    logger.info("Querying lease costs via commercial bridge", {
      accounts: Object.keys(accountsWithStartDates).length,
    });

    for (const [accountId, startDate] of Object.entries(
      accountsWithStartDates,
    )) {
      await this.accumulateAccountCost(report, accountId, startDate, end);
    }
    return report;
  }

  async getCostForRange(
    start: DateTime,
    end: DateTime,
    accountsWithStartDates: Record<string, DateTime>,
    tag?: { tagName: string; tagValues: string[] },
  ): Promise<AccountsCostReport> {
    if (tag) {
      logger.warn(
        "Tag filtering is not supported via the commercial bridge; returning unfiltered costs.",
        { tagName: tag.tagName },
      );
    }

    const report = new AccountsCostReport();
    logger.info("Querying cost range via commercial bridge", {
      accounts: Object.keys(accountsWithStartDates).length,
      start: start.toISODate(),
      end: end.toISODate(),
    });

    for (const accountId of Object.keys(accountsWithStartDates)) {
      await this.accumulateAccountCost(report, accountId, start, end);
    }
    return report;
  }

  async getDailyCostsByAccount(
    accountIds: string[],
    start: DateTime,
    end: DateTime,
    _maxConcurrency = 5,
  ): Promise<Record<string, Record<string, number>>> {
    // The commercial bridge returns a single aggregated total per account per
    // query rather than a per-day breakdown, so this reports the range total
    // under the start date. Group cost reporting aggregates by group total, so
    // the group figures remain correct; only per-day granularity is lost.
    const result: Record<string, Record<string, number>> = {};
    const dateKey = start.toUTC().toFormat("yyyy-MM-dd");

    for (const accountId of accountIds) {
      const total = await this.queryAggregatedCost(accountId, start, end);
      if (total !== undefined) {
        result[accountId] = { [dateKey]: total };
      }
    }
    return result;
  }

  /**
   * Query the aggregated cost for one account across all GovCloud regions and
   * add it to the report under the GovCloud account id. Missing mappings and
   * per-region errors are logged and skipped so one account cannot fail a whole
   * monitoring run.
   */
  private async accumulateAccountCost(
    report: AccountsCostReport,
    accountId: string,
    start: DateTime,
    end: DateTime,
  ): Promise<void> {
    const total = await this.queryAggregatedCost(accountId, start, end);
    if (total !== undefined) {
      report.addCost(accountId, total);
    }
  }

  private async queryAggregatedCost(
    govCloudAccountId: string,
    start: DateTime,
    end: DateTime,
  ): Promise<number | undefined> {
    const accountResponse =
      await this.config.sandboxAccountStore.get(govCloudAccountId);
    if (accountResponse.error) {
      logger.warn("Error retrieving account for cost mapping", {
        govCloudAccountId,
        error: accountResponse.error,
      });
    }
    const commercialAccountId =
      accountResponse.result?.commercialLinkedAccountId;

    let total = 0;
    let anySucceeded = false;

    for (const region of this.config.govCloudRegions) {
      try {
        const response = await this.client.queryCost({
          linkedAccountId: govCloudAccountId,
          isGovCloudAccountId: true,
          commercialAccountId,
          // Cost Explorer date boundaries are UTC; normalize to avoid an
          // off-by-one day when the Lambda runs in a non-UTC context.
          startDate: start.toUTC().toFormat("yyyy-MM-dd"),
          endDate: end.toUTC().toFormat("yyyy-MM-dd"),
          granularity: "DAILY",
          region,
        });
        total += response.totalCost;
        anySucceeded = true;
      } catch (error) {
        if (error instanceof CommercialBridgeAccountMappingNotFoundError) {
          logger.warn(
            "No commercial account mapping for GovCloud account; skipping cost. " +
              "Set commercialLinkedAccountId on the account record to enable tracking.",
            { govCloudAccountId, region },
          );
          return undefined;
        }
        logger.error("Failed to query commercial bridge cost", {
          govCloudAccountId,
          region,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return anySucceeded ? total : undefined;
  }
}
