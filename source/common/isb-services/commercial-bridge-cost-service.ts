// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { DateTime } from "luxon";

import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import { ICostService } from "@amzn/innovation-sandbox-commons/isb-services/cost-service.js";
import { AccountsCostReport } from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";
import {
  CommercialBridgeAccountMappingNotFoundError,
  CommercialBridgeClient,
} from "@amzn/innovation-sandbox-commons/isb-services/commercial-bridge-client.js";
import { createCommercialBridgeClient } from "@amzn/innovation-sandbox-commons/isb-services/commercial-bridge-factory.js";
import { CommercialBridgeEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/commercial-bridge-environment.js";

const logger = new Logger({ serviceName: "CommercialBridgeCostService" });

export class CommercialBridgeCostService implements ICostService {
  private readonly client: CommercialBridgeClient;

  constructor(
    private readonly config: {
      commercialBridgeEnv: CommercialBridgeEnvironment;
      govCloudRegions: string[];
      sandboxAccountStore: SandboxAccountStore;
    },
  ) {
    this.client = createCommercialBridgeClient(config.commercialBridgeEnv);
  }

  async getCostForLeases(
    accountsWithStartDates: Record<string, DateTime>,
    end: DateTime,
    granularity: "DAILY" | "HOURLY" = "DAILY",
  ): Promise<AccountsCostReport> {
    const accountsCost = new AccountsCostReport();

    logger.info(
      `Querying costs for ${Object.keys(accountsWithStartDates).length} accounts via commercial bridge`,
    );

    // Process each GovCloud account
    for (const [govCloudAccountId, startDate] of Object.entries(
      accountsWithStartDates,
    )) {
      // Get commercial account mapping if available
      const accountResponse = await this.config.sandboxAccountStore.get(
        govCloudAccountId,
      );
      const commercialAccountId =
        accountResponse.result?.commercialLinkedAccountId;

      if (accountResponse.error) {
        logger.warn(
          `Error retrieving account ${govCloudAccountId}: ${accountResponse.error}`,
        );
      }

      // Query each GovCloud region separately
      for (const region of this.config.govCloudRegions) {
        try {
          const response = await this.client.queryCost({
            linkedAccountId: govCloudAccountId,
            isGovCloudAccountId: true,
            commercialAccountId: commercialAccountId, // Use manual mapping if available
            startDate: startDate.toFormat("yyyy-MM-dd"),
            endDate: end.toFormat("yyyy-MM-dd"),
            granularity: granularity === "HOURLY" ? "DAILY" : granularity, // Commercial bridge only supports DAILY/MONTHLY
            region: region,
          });

          // Accumulate cost under GovCloud account ID for lease tracking
          accountsCost.addCost(govCloudAccountId, response.totalCost);

          logger.debug(`Cost retrieved for account ${govCloudAccountId}`, {
            region,
            cost: response.totalCost,
            commercialAccountId: response.commercialAccountId,
          });
        } catch (error) {
          if (error instanceof CommercialBridgeAccountMappingNotFoundError) {
            logger.warn(
              `No commercial account mapping found for GovCloud account ${govCloudAccountId}. Skipping cost polling for this account. To enable cost tracking, add the commercialLinkedAccountId to the account record.`,
              {
                govCloudAccountId,
                region,
              },
            );
          } else {
            logger.error(
              `Failed to get costs for account ${govCloudAccountId} in ${region}`,
              {
                error: error instanceof Error ? error.message : String(error),
                govCloudAccountId,
                region,
              },
            );
          }
          // Continue with other accounts/regions
        }
      }
    }

    return accountsCost;
  }

  async getCostForRange(
    start: DateTime,
    end: DateTime,
    accountsWithStartDates: Record<string, DateTime>,
    tag?: { tagName: string; tagValues: string[] },
  ): Promise<AccountsCostReport> {
    const accountsCost = new AccountsCostReport();

    logger.info(
      `Querying cost range for ${Object.keys(accountsWithStartDates).length} accounts via commercial bridge`,
      {
        start: start.toISO(),
        end: end.toISO(),
        tag: tag?.tagName,
      },
    );

    // Process each GovCloud account
    for (const [govCloudAccountId] of Object.entries(
      accountsWithStartDates,
    )) {
      // Get commercial account mapping if available
      const accountResponse = await this.config.sandboxAccountStore.get(
        govCloudAccountId,
      );
      const commercialAccountId =
        accountResponse.result?.commercialLinkedAccountId;

      if (accountResponse.error) {
        logger.warn(
          `Error retrieving account ${govCloudAccountId}: ${accountResponse.error}`,
        );
      }

      // Query each GovCloud region separately
      for (const region of this.config.govCloudRegions) {
        try {
          const response = await this.client.queryCost({
            linkedAccountId: govCloudAccountId,
            isGovCloudAccountId: true,
            commercialAccountId: commercialAccountId,
            startDate: start.toFormat("yyyy-MM-dd"),
            endDate: end.toFormat("yyyy-MM-dd"),
            granularity: "DAILY",
            region: region,
          });

          // Accumulate cost under GovCloud account ID
          accountsCost.addCost(govCloudAccountId, response.totalCost);

          logger.debug(`Cost range retrieved for account ${govCloudAccountId}`, {
            region,
            cost: response.totalCost,
            commercialAccountId: response.commercialAccountId,
          });
        } catch (error) {
          if (error instanceof CommercialBridgeAccountMappingNotFoundError) {
            logger.warn(
              `No commercial account mapping found for GovCloud account ${govCloudAccountId}. Skipping cost polling.`,
              {
                govCloudAccountId,
                region,
              },
            );
          } else {
            logger.error(
              `Failed to get cost range for account ${govCloudAccountId} in ${region}`,
              {
                error: error instanceof Error ? error.message : String(error),
                govCloudAccountId,
                region,
              },
            );
          }
        }
      }
    }

    // Note: Tag filtering is not supported via commercial bridge API
    // Tags are applied at the Cost Explorer level in the commercial account
    if (tag) {
      logger.warn(
        "Tag filtering requested but not supported via commercial bridge API. Returning unfiltered costs.",
        {
          tagName: tag.tagName,
        },
      );
    }

    return accountsCost;
  }
}
