// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "vitest";

import { SandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";

/**
 * v2 added the optional commercialLinkedAccountId field (GovCloud cost
 * mapping). Because the field is optional, v1 records — which never had it —
 * remain valid under the current schema with no data migration required. A v2
 * record with the field also validates.
 */
test("SandboxAccount v1 records (no commercialLinkedAccountId) still validate", () => {
  const v1Account = {
    awsAccountId: "123456789012",
    email: "test@example.com",
    name: "test-account",
    status: "Available",
    meta: {
      schemaVersion: 1,
      createdTime: "2024-01-01T00:00:00.000Z",
      lastEditTime: "2024-01-01T00:00:00.000Z",
    },
  };

  const parsed = SandboxAccountSchema.parse(v1Account);
  expect(parsed.commercialLinkedAccountId).toBeUndefined();
});

test("SandboxAccount records with commercialLinkedAccountId validate", () => {
  const v2Account = {
    awsAccountId: "123456789012",
    email: "test@example.com",
    name: "test-account",
    status: "Available",
    commercialLinkedAccountId: "210987654321",
    meta: {
      schemaVersion: 2,
      createdTime: "2024-01-01T00:00:00.000Z",
      lastEditTime: "2024-01-01T00:00:00.000Z",
    },
  };

  const parsed = SandboxAccountSchema.parse(v2Account);
  expect(parsed.commercialLinkedAccountId).toEqual("210987654321");
});
