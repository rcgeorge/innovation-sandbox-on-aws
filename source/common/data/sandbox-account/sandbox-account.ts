// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import {
  AwsAccountIdSchema,
  enumErrorMap,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
// v2: added optional commercialLinkedAccountId (GovCloud cost mapping).
export const SandboxAccountSchemaVersion = 2;

// Define supported version range for backwards compatibility. v1 records (which
// predate commercialLinkedAccountId) remain valid because the field is optional.
const SandboxAccountSupportedVersionsSchema = createVersionRangeSchema(
  1,
  SandboxAccountSchemaVersion,
);

// Create ItemWithMetadata schema with version validation
const SandboxAccountItemWithMetadataSchema = createItemWithMetadataSchema(
  SandboxAccountSupportedVersionsSchema,
);

export const IsbOuSchema = z.enum(
  ["Available", "Active", "CleanUp", "Quarantine", "Frozen", "Entry", "Exit"],
  {
    errorMap: enumErrorMap,
  },
);

export const SandboxAccountStatusSchema = IsbOuSchema.exclude([
  "Entry",
  "Exit",
]);

export const SandboxAccountSchema = z
  .object({
    awsAccountId: AwsAccountIdSchema,
    email: z.string().email().optional(),
    name: z.string().max(50).optional(),
    cleanupExecutionContext: z
      .object({
        stateMachineExecutionArn: z.string(),
        stateMachineExecutionStartTime: z.string().datetime(),
      })
      .optional(),
    status: SandboxAccountStatusSchema,
    driftAtLastScan: z.boolean().optional(),
    // For GovCloud deployments: the commercial (aws partition) linked account
    // whose bill carries this GovCloud account's usage. Used by the commercial
    // bridge cost service to map a GovCloud account id to the commercial
    // account Cost Explorer reports against. Undefined for commercial
    // deployments and for GovCloud accounts using bridge auto-discovery.
    commercialLinkedAccountId: AwsAccountIdSchema.optional(),
  })
  .merge(SandboxAccountItemWithMetadataSchema)
  .strict();

export type SandboxAccount = z.infer<typeof SandboxAccountSchema>;
export type IsbOu = z.infer<typeof IsbOuSchema>;
export type SandboxAccountStatus = z.infer<typeof SandboxAccountStatusSchema>;
