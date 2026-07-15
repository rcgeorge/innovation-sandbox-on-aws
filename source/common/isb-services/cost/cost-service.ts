// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DateTime } from "luxon";

import { AccountsCostReport } from "@amzn/innovation-sandbox-commons/isb-services/cost/accounts-cost-report.js";

/**
 * Interface for cost retrieval services. Implementations:
 * - CostExplorerService: direct AWS Cost Explorer API (commercial partition).
 * - CommercialBridgeCostService: cross-partition proxy to a commercial bridge
 *   API (GovCloud, where Cost Explorer is not available).
 *
 * The three methods here are the ones consumed outside the service:
 * - getCostForLeases   → lease-monitoring (budget/threshold enforcement)
 * - getCostForRange    → cost-reporting (monthly sandbox + solution costs)
 * - getDailyCostsByAccount → group-cost-reporting (per-group CSV report)
 */
export interface ICostService {
  getCostForLeases(
    accountsWithStartDates: Record<string, DateTime>,
    end: DateTime,
    granularity?: "DAILY" | "HOURLY",
  ): Promise<AccountsCostReport>;

  getCostForRange(
    start: DateTime,
    end: DateTime,
    accountsWithStartDates: Record<string, DateTime>,
    tag?: { tagName: string; tagValues: string[] },
  ): Promise<AccountsCostReport>;

  getDailyCostsByAccount(
    accountIds: string[],
    start: DateTime,
    end: DateTime,
    maxConcurrency?: number,
  ): Promise<Record<string, Record<string, number>>>;
}
