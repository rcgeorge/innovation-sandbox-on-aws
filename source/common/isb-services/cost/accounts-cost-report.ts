// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared cost DTO used by all cost service implementations (Cost Explorer and
 * the commercial bridge). Kept in its own module — with no AWS SDK imports — so
 * the ICostService interface and both implementations can reference it without
 * pulling in @aws-sdk/client-cost-explorer.
 */
export class AccountsCostReport {
  readonly costMap: Record<string, number>;

  constructor() {
    this.costMap = {};
  }
  public addCost(accountId: string, toAdd: number) {
    if (this.costMap[accountId]) {
      this.costMap[accountId] = this.costMap[accountId] + toAdd;
    } else {
      this.costMap[accountId] = toAdd;
    }
  }
  public getCost(accountId: string): number {
    return this.costMap[accountId] ?? 0;
  }
  public merge(accountsCost: AccountsCostReport) {
    for (const [key, value] of Object.entries(accountsCost.costMap)) {
      this.addCost(key, value);
    }
  }

  public totalCost() {
    return Object.entries(this.costMap).reduce((acc, [_, value]) => {
      return acc + value;
    }, 0);
  }
}
