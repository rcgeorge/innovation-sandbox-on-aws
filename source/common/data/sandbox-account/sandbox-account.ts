// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/data/common-schemas.js";
import { ItemWithMetadataSchema } from "@amzn/innovation-sandbox-commons/data/metadata.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
export const SandboxAccountSchemaVersion = 1;

export const IsbOuSchema = z.enum([
  "Available",
  "Active",
  "CleanUp",
  "Quarantine",
  "Frozen",
  "Entry",
  "Exit",
]);

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
    commercialLinkedAccountId: AwsAccountIdSchema.optional(), // NEW: For GovCloud cost tracking
  })
  .merge(ItemWithMetadataSchema)
  .strict();

export type SandboxAccount = z.infer<typeof SandboxAccountSchema>;
export type IsbOu = z.infer<typeof IsbOuSchema>;
export type SandboxAccountStatus = z.infer<typeof SandboxAccountStatusSchema>;
