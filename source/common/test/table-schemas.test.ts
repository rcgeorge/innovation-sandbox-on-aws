// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * maintaining accurate and consistent schema versions for all tables is critical to the update methodology
 * of the solution (described in ADR-0002)
 *
 * this file tests that all schemas match their specified schema version. if a test fails, the test should be
 * updated to pass ONLY after verifying that schema versions have been correctly maintained.
 *
 * rules for updating schema version:
 *   - if any fields have been added or changed since the last public release of the solution, the schema version
 *   must be incremented exactly once for the next release of the solution.
 *   - changes to any schema must also include a migration script and related migration test (under test/migration)
 *   that ensures data can be safely migrated.
 */
import objectHash from "object-hash";
import { expect, test } from "vitest";

import {
  LeaseTemplateSchema,
  LeaseTemplateSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  ApprovalDeniedLeaseSchema,
  ExpiredLeaseSchema,
  LeaseSchemaVersion,
  MonitoredLeaseSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  SandboxAccountSchema,
  SandboxAccountSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";

test("LeaseTemplate Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(LeaseTemplateSchema.shape)).toMatchInlineSnapshot(
    `"19dc6f9747e7b343e53cf1cdcaee6ffc09f04213"`,
  );
  expect(LeaseTemplateSchemaVersion).toEqual(1);
});

test("Lease Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(PendingLeaseSchema.shape)).toMatchInlineSnapshot(
    `"a372699977e8d124535a2cfa5494b9d6e9017d7d"`,
  );
  expect(
    objectHash.sha1(ApprovalDeniedLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"1ad5c3388cfb4adfd2aaf90895699e99138fd111"`);
  expect(objectHash.sha1(MonitoredLeaseSchema.shape)).toMatchInlineSnapshot(
    `"a3cabc98ccef220ca9aa3afee038db34a2d1382f"`,
  );
  expect(objectHash.sha1(ExpiredLeaseSchema.shape)).toMatchInlineSnapshot(
    `"651af226403ce14cbf7b488ade003fb1dc8252da"`,
  );
  expect(LeaseSchemaVersion).toEqual(1);
});

test("SandboxAccount Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(SandboxAccountSchema.shape)).toMatchInlineSnapshot(
    `"7c239f345d00a68829596c72731d34db84081497"`,
  );
  expect(SandboxAccountSchemaVersion).toEqual(1);
});
