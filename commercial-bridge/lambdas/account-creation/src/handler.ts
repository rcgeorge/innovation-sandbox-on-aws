// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Commercial-partition GovCloud account provisioning. CreateGovCloudAccount
 * (and its paired commercial account) can only be called from the commercial
 * Organizations management account, so GovCloud orchestration calls this API.
 *
 *   POST /govcloud-accounts                 → initiate creation, returns requestId
 *   GET  /govcloud-accounts                 → list created GovCloud accounts
 *   GET  /govcloud-accounts/{requestId}     → creation status
 *
 * Account creation takes minutes (longer than API Gateway's 29s), so POST
 * returns immediately with a requestId to poll.
 */
import {
  CreateAccountState,
  CreateGovCloudAccountCommand,
  DescribeCreateAccountStatusCommand,
  ListCreateAccountStatusCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";

const organizations = new OrganizationsClient({});
const JSON_HEADERS = { "Content-Type": "application/json" };

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 64;
}

/**
 * Alias the email DETERMINISTICALLY from the account name so that a retry or a
 * duplicate event for the same logical request maps to the same mailbox, e.g.
 * user@example.com + "Team A" → user+govcloud-team-a@example.com. A
 * timestamp-based alias would mint a brand-new (irreversible, billable) account
 * pair on every retry.
 */
function aliasEmail(baseEmail: string, accountName: string): string {
  const [localPart, domain] = baseEmail.split("@");
  const slug = accountName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${localPart}+govcloud-${slug}@${domain}`;
}

/**
 * Find an existing create-account request (in-progress or already succeeded)
 * for this account name so we don't launch a duplicate. Account creation is
 * neither cheap nor reversible, and the request can arrive more than once
 * (EventBridge at-least-once delivery, Step Function retries, double-submits).
 */
async function findExistingRequest(
  accountName: string,
): Promise<string | undefined> {
  let nextToken: string | undefined;
  do {
    const res = await organizations.send(
      new ListCreateAccountStatusCommand({
        States: [
          CreateAccountState.IN_PROGRESS,
          CreateAccountState.SUCCEEDED,
        ],
        NextToken: nextToken,
      }),
    );
    const match = (res.CreateAccountStatuses ?? []).find(
      (s) => s.AccountName === accountName,
    );
    if (match?.Id) {
      return match.Id;
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return undefined;
}

async function handleCreate(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  if (!event.body) return response(400, { error: "Request body is required" });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body);
  } catch {
    return response(400, { error: "Invalid JSON in request body" });
  }

  const email = body.email as string;
  const accountName = (body.accountName as string)?.trim();
  if (!email || !isValidEmail(email)) {
    return response(400, { error: "Valid email is required" });
  }
  if (!accountName || accountName.length === 0 || accountName.length > 50) {
    return response(400, {
      error: "accountName is required and must be at most 50 characters",
    });
  }
  const roleName = (body.roleName as string) || "OrganizationAccountAccessRole";
  if (!/^[\w+=,.@-]{1,64}$/.test(roleName)) {
    return response(400, { error: "roleName contains invalid characters" });
  }
  const iamUserAccessToBilling =
    (body.iamUserAccessToBilling as string) === "ALLOW" ? "ALLOW" : "DENY";

  // Idempotency guard: return an in-flight/completed request for the same
  // account name instead of creating a second account pair.
  const existingRequestId = await findExistingRequest(accountName);
  if (existingRequestId) {
    return response(202, {
      requestId: existingRequestId,
      status: "IN_PROGRESS",
      message: "Existing account-creation request reused (idempotent).",
    });
  }

  const uniqueEmail = aliasEmail(email, accountName);

  const result = await organizations.send(
    new CreateGovCloudAccountCommand({
      Email: uniqueEmail,
      AccountName: accountName,
      RoleName: roleName,
      IamUserAccessToBilling: iamUserAccessToBilling,
    }),
  );

  const requestId = result.CreateAccountStatus?.Id;
  if (!requestId) {
    throw new Error("CreateGovCloudAccount did not return a request id");
  }

  return response(202, {
    requestId,
    status: "IN_PROGRESS",
    message:
      "Account creation initiated. Poll GET /govcloud-accounts/{requestId}.",
  });
}

async function handleStatus(requestId: string): Promise<APIGatewayProxyResult> {
  const res = await organizations.send(
    new DescribeCreateAccountStatusCommand({
      CreateAccountRequestId: requestId,
    }),
  );
  const status = res.CreateAccountStatus;
  return response(200, {
    requestId,
    status: status?.State ?? "UNKNOWN",
    govCloudAccountId: status?.GovCloudAccountId,
    commercialAccountId: status?.AccountId,
    message:
      status?.State === CreateAccountState.FAILED
        ? status.FailureReason
        : undefined,
  });
}

async function handleList(): Promise<APIGatewayProxyResult> {
  const accounts: unknown[] = [];
  let nextToken: string | undefined;
  do {
    const res = await organizations.send(
      new ListCreateAccountStatusCommand({
        States: [CreateAccountState.SUCCEEDED],
        NextToken: nextToken,
      }),
    );
    for (const s of res.CreateAccountStatuses ?? []) {
      if (s.GovCloudAccountId) {
        accounts.push({
          requestId: s.Id,
          govCloudAccountId: s.GovCloudAccountId,
          commercialAccountId: s.AccountId,
          accountName: s.AccountName ?? "Unknown",
        });
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return response(200, { accounts });
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const requestId = event.pathParameters?.requestId;
    if (event.httpMethod === "GET") {
      return requestId ? handleStatus(requestId) : handleList();
    }
    if (event.httpMethod === "POST") {
      return handleCreate(event);
    }
    return response(405, { error: "Method not allowed" });
  } catch (error) {
    return response(500, {
      error: "Failed to process GovCloud account request",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
