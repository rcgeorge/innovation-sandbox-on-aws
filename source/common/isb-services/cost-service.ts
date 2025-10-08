// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";
import { AccountsCostReport } from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";

/**
 * Interface for cost retrieval services.
 * Implementations include:
 * - CostExplorerService: Direct AWS Cost Explorer API (commercial AWS)
 * - CommercialBridgeCostService: Commercial bridge API proxy (GovCloud)
 */
export interface ICostService {
  /**
   * Get costs for active leases from their start dates until the specified end time.
   * @param accountsWithStartDates Map of account IDs to their lease start dates
   * @param end End datetime for cost query
   * @param granularity Granularity for cost data (DAILY or HOURLY)
   * @returns AccountsCostReport with cost per account
   */
  getCostForLeases(
    accountsWithStartDates: Record<string, DateTime>,
    end: DateTime,
    granularity?: "DAILY" | "HOURLY",
  ): Promise<AccountsCostReport>;

  /**
   * Get costs for a specific date range for multiple accounts.
   * @param start Start datetime
   * @param end End datetime
   * @param accountsWithStartDates Map of account IDs to their start dates (for filtering)
   * @param tag Optional cost allocation tag filter
   * @returns AccountsCostReport with cost per account
   */
  getCostForRange(
    start: DateTime,
    end: DateTime,
    accountsWithStartDates: Record<string, DateTime>,
    tag?: { tagName: string; tagValues: string[] },
  ): Promise<AccountsCostReport>;
}
