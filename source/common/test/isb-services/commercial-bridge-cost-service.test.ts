// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommercialBridgeAccountMappingNotFoundError } from "@amzn/innovation-sandbox-commons/isb-services/cost/commercial-bridge-client.js";

const queryCostMock = vi.fn();

// The service builds its client through the factory; mock the factory to return
// a stub client so no real network/Roles Anywhere calls happen.
vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/cost/commercial-bridge-factory.js",
  () => ({
    createCommercialBridgeClient: () => ({ queryCost: queryCostMock }),
  }),
);

const { CommercialBridgeCostService } = await import(
  "@amzn/innovation-sandbox-commons/isb-services/cost/commercial-bridge-cost-service.js"
);

const bridgeEnv = {
  COMMERCIAL_BRIDGE_API_URL: "https://bridge.example.com",
  COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN: "arn:secret",
  COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN: "arn:ta",
  COMMERCIAL_BRIDGE_PROFILE_ARN: "arn:profile",
  COMMERCIAL_BRIDGE_ROLE_ARN: "arn:role",
};

function makeStore(commercialLinkedAccountId?: string, error?: string) {
  return {
    get: vi.fn().mockResolvedValue({
      result: commercialLinkedAccountId
        ? { commercialLinkedAccountId }
        : { awsAccountId: "111111111111" },
      error,
    }),
  } as any;
}

function makeService(store: any, regions = ["us-gov-east-1", "us-gov-west-1"]) {
  return new CommercialBridgeCostService({
    commercialBridgeEnv: bridgeEnv,
    govCloudRegions: regions,
    sandboxAccountStore: store,
  });
}

const start = DateTime.fromISO("2026-01-01T00:00:00Z");
const end = DateTime.fromISO("2026-01-31T00:00:00Z");

beforeEach(() => {
  queryCostMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CommercialBridgeCostService", () => {
  it("sums cost across all GovCloud regions per account (getCostForLeases)", async () => {
    queryCostMock
      .mockResolvedValueOnce({ totalCost: 10 } as any) // us-gov-east-1
      .mockResolvedValueOnce({ totalCost: 5 } as any); // us-gov-west-1

    const service = makeService(makeStore("222222222222"));
    const report = await service.getCostForLeases(
      { "111111111111": start },
      end,
    );

    expect(report.getCost("111111111111")).toBe(15);
    expect(queryCostMock).toHaveBeenCalledTimes(2);
    // commercialAccountId from the account mapping is forwarded.
    expect(queryCostMock.mock.calls[0]![0].commercialAccountId).toBe(
      "222222222222",
    );
    expect(queryCostMock.mock.calls[0]![0].isGovCloudAccountId).toBe(true);
  });

  it("skips an account with no commercial mapping (404) without failing others", async () => {
    // Account A: both regions 404 (no mapping). Account B: succeeds.
    queryCostMock.mockImplementation((params: any) => {
      if (params.linkedAccountId === "aaaaaaaaaaaa") {
        return Promise.reject(
          new CommercialBridgeAccountMappingNotFoundError("no mapping"),
        );
      }
      return Promise.resolve({ totalCost: 7 });
    });

    const service = makeService(makeStore());
    const report = await service.getCostForLeases(
      { aaaaaaaaaaaa: start, bbbbbbbbbbbb: start },
      end,
    );

    // Unmapped account contributes nothing; mapped account is summed per region.
    expect(report.getCost("aaaaaaaaaaaa")).toBe(0);
    expect(report.getCost("bbbbbbbbbbbb")).toBe(14);
  });

  it("continues when one region errors but another succeeds", async () => {
    queryCostMock
      .mockRejectedValueOnce(new Error("region down")) // us-gov-east-1
      .mockResolvedValueOnce({ totalCost: 9 } as any); // us-gov-west-1

    const service = makeService(makeStore("222222222222"));
    const report = await service.getCostForLeases(
      { "111111111111": start },
      end,
    );

    expect(report.getCost("111111111111")).toBe(9);
  });

  it("getCostForRange ignores tag filtering (unsupported) but still returns costs", async () => {
    queryCostMock.mockResolvedValue({ totalCost: 3 } as any);

    const service = makeService(makeStore("222222222222"));
    const report = await service.getCostForRange(
      start,
      end,
      { "111111111111": start },
      { tagName: "Isb", tagValues: ["x"] },
    );

    expect(report.getCost("111111111111")).toBe(6); // 3 per region * 2
  });

  it("getDailyCostsByAccount returns the range total under the start date", async () => {
    queryCostMock.mockResolvedValue({ totalCost: 4 } as any);

    const service = makeService(makeStore("222222222222"), ["us-gov-east-1"]);
    const result = await service.getDailyCostsByAccount(
      ["111111111111"],
      start,
      end,
    );

    expect(result["111111111111"]).toEqual({ "2026-01-01": 4 });
  });
});
