// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestrator for cross-partition GovCloud account provisioning, invoked
 * step-by-step by the GovCloud provisioning Step Function. Each action takes
 * and returns plain JSON that the state machine threads between steps:
 *
 *   create          → commercial bridge CreateGovCloudAccount, returns requestId
 *   checkStatus     → poll bridge status, returns {status, govCloudAccountId, commercialAccountId}
 *   sendInvitation  → GovCloud org invites the new account, returns handshakeId
 *   acceptInvitation→ commercial bridge accepts the handshake (cross-partition)
 *   moveToEntry     → move the account into the ISB Entry OU + record the
 *                     commercial linked account mapping
 *
 * Once the account lands in Entry it enters the existing ISB lifecycle
 * (registration → CleanUp → Available), so no bespoke registration is needed.
 */
import { Logger } from "@aws-lambda-powertools/logger";
import {
  InviteAccountToOrganizationCommand,
  ListParentsCommand,
  MoveAccountCommand,
  OrganizationsClient,
  TagResourceCommand,
} from "@aws-sdk/client-organizations";

import { createCommercialBridgeClient } from "@amzn/innovation-sandbox-commons/isb-services/cost/commercial-bridge-factory.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { COMMERCIAL_LINKED_ACCOUNT_TAG_KEY } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { GovCloudProvisioningLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/govcloud-provisioning-lambda-environment.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

const logger = new Logger({ serviceName: "govcloud-provisioning" });

type Action =
  | "create"
  | "checkStatus"
  | "sendInvitation"
  | "acceptInvitation"
  | "moveToEntry";

interface ProvisioningEvent {
  action: Action;
  accountName?: string;
  email?: string;
  requestId?: string;
  govCloudAccountId?: string;
  commercialAccountId?: string;
  handshakeId?: string;
}

function env(): GovCloudProvisioningLambdaEnvironment {
  return process.env as unknown as GovCloudProvisioningLambdaEnvironment;
}

function requireField<K extends keyof ProvisioningEvent>(
  event: ProvisioningEvent,
  key: K,
): NonNullable<ProvisioningEvent[K]> {
  const value = event[key];
  if (value === undefined || value === null) {
    throw new Error(`Missing required field '${String(key)}' for action ${event.action}`);
  }
  return value as NonNullable<ProvisioningEvent[K]>;
}

// AWS Organizations account-name and email constraints. The API-layer Zod
// schema validates these at request time, but the orchestrator can also be
// driven directly by the Step Function off an EventBridge event, so re-validate
// here as defense-in-depth before spending money on a real account.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateAccountName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 50) {
    throw new Error("accountName must be between 1 and 50 characters");
  }
  return trimmed;
}

function validateEmail(email: string): string {
  const trimmed = email.trim();
  if (!EMAIL_REGEX.test(trimmed) || trimmed.length > 64) {
    throw new Error("email must be a valid address no longer than 64 characters");
  }
  return trimmed;
}

export async function handler(
  event: ProvisioningEvent,
): Promise<Record<string, unknown>> {
  logger.info("GovCloud provisioning action", { action: event.action });
  const bridge = createCommercialBridgeClient(env());

  switch (event.action) {
    case "create": {
      const res = await bridge.createGovCloudAccount({
        accountName: validateAccountName(requireField(event, "accountName")),
        email: validateEmail(requireField(event, "email")),
      });
      return { requestId: res.requestId, status: res.status };
    }

    case "checkStatus": {
      const res = await bridge.getGovCloudAccountStatus(
        requireField(event, "requestId"),
      );
      return {
        status: res.status,
        govCloudAccountId: res.govCloudAccountId,
        commercialAccountId: res.commercialAccountId,
        message: res.message,
      };
    }

    case "sendInvitation": {
      const govCloudAccountId = requireField(event, "govCloudAccountId");
      const orgs = new OrganizationsClient({
        region: env().GOVCLOUD_HOME_REGION,
        credentials: fromTemporaryIsbOrgManagementCredentials(env()),
      });
      const res = await orgs.send(
        new InviteAccountToOrganizationCommand({
          Target: { Id: govCloudAccountId, Type: "ACCOUNT" },
          Notes: "Innovation Sandbox GovCloud account provisioning",
        }),
      );
      const handshakeId = res.Handshake?.Id;
      if (!handshakeId) {
        throw new Error("InviteAccountToOrganization returned no handshake id");
      }
      return { handshakeId, govCloudAccountId };
    }

    case "acceptInvitation": {
      const res = await bridge.acceptInvitation({
        govCloudAccountId: requireField(event, "govCloudAccountId"),
        commercialLinkedAccountId: requireField(event, "commercialAccountId"),
        handshakeId: requireField(event, "handshakeId"),
        govCloudRegion: env().GOVCLOUD_HOME_REGION,
      });
      return { handshakeState: res.handshakeState };
    }

    case "moveToEntry": {
      const govCloudAccountId = requireField(event, "govCloudAccountId");
      const commercialAccountId = requireField(event, "commercialAccountId");
      const credentials = fromTemporaryIsbOrgManagementCredentials(env());
      const orgs = new OrganizationsClient({
        region: env().GOVCLOUD_HOME_REGION,
        credentials,
      });

      const { entryOuId } = await IsbServices.accountPoolStackConfigStore(
        env(),
      ).get();

      // Idempotent move: a freshly-joined account lands under the org root, but
      // on a Step Function retry it may already be in Entry. Read the current
      // parent and only move when needed, using the ACTUAL current parent as the
      // source — assuming "root" would fail if the account has already moved.
      const parents = await orgs.send(
        new ListParentsCommand({ ChildId: govCloudAccountId }),
      );
      const currentParentId = parents.Parents?.[0]?.Id;
      if (!currentParentId) {
        throw new Error(
          `Could not determine current parent for account ${govCloudAccountId}`,
        );
      }
      if (currentParentId !== entryOuId) {
        await orgs.send(
          new MoveAccountCommand({
            AccountId: govCloudAccountId,
            SourceParentId: currentParentId,
            DestinationParentId: entryOuId,
          }),
        );
      }

      // Persist the commercial linked account mapping durably as an
      // Organizations tag so it survives until ISB registration creates the
      // DynamoDB record (which reads this tag). Also update the record directly
      // if it already exists (e.g. the account was registered before this step).
      // If neither succeeds the cost bridge still resolves the mapping via
      // Organizations auto-discovery, so tagging failure is non-fatal.
      await orgs.send(
        new TagResourceCommand({
          ResourceId: govCloudAccountId,
          Tags: [
            {
              Key: COMMERCIAL_LINKED_ACCOUNT_TAG_KEY,
              Value: commercialAccountId,
            },
          ],
        }),
      );

      const accountStore = IsbServices.sandboxAccountStore(env());
      const existing = await accountStore.get(govCloudAccountId);
      if (existing.result) {
        await accountStore.put({
          ...existing.result,
          commercialLinkedAccountId: commercialAccountId,
        });
      }
      return { govCloudAccountId, movedTo: "Entry", commercialAccountId };
    }

    default: {
      throw new Error(`Unknown action: ${event.action as string}`);
    }
  }
}
