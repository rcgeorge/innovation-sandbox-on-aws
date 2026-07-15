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
  ListRootsCommand,
  MoveAccountCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";

import { createCommercialBridgeClient } from "@amzn/innovation-sandbox-commons/isb-services/cost/commercial-bridge-factory.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
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

export async function handler(
  event: ProvisioningEvent,
): Promise<Record<string, unknown>> {
  logger.info("GovCloud provisioning action", { action: event.action });
  const bridge = createCommercialBridgeClient(env());

  switch (event.action) {
    case "create": {
      const res = await bridge.createGovCloudAccount({
        accountName: requireField(event, "accountName"),
        email: requireField(event, "email"),
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

      // A freshly-joined account lands directly under the org root; move it
      // into the ISB Entry OU so it enters the normal onboarding lifecycle.
      const roots = await orgs.send(new ListRootsCommand({}));
      const rootId = roots.Roots?.[0]?.Id;
      if (!rootId) {
        throw new Error("Could not determine the GovCloud organization root id");
      }
      const { entryOuId } = await IsbServices.accountPoolStackConfigStore(
        env(),
      ).get();
      await orgs.send(
        new MoveAccountCommand({
          AccountId: govCloudAccountId,
          SourceParentId: rootId,
          DestinationParentId: entryOuId,
        }),
      );

      // Record the commercial linked account so the cost bridge can map this
      // GovCloud account to the commercial bill. The account record is created
      // later during ISB registration, so only update if it already exists.
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
