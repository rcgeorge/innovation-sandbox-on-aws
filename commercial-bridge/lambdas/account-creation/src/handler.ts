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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Alias the email so repeated provisioning from one mailbox stays unique, e.g.
 * user@example.com → user+govcloud-<timestamp>@example.com. The timestamp comes
 * from the request context (deterministic per invocation) rather than Date.now
 * at module scope.
 */
function aliasEmail(baseEmail: string, requestTimeEpochMs: number): string {
  const [localPart, domain] = baseEmail.split("@");
  return `${localPart}+govcloud-${requestTimeEpochMs}@${domain}`;
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
  const accountName = body.accountName as string;
  if (!email || !isValidEmail(email)) {
    return response(400, { error: "Valid email is required" });
  }
  if (!accountName || accountName.trim().length === 0) {
    return response(400, { error: "accountName is required" });
  }

  const uniqueEmail = aliasEmail(
    email,
    event.requestContext.requestTimeEpoch,
  );

  const result = await organizations.send(
    new CreateGovCloudAccountCommand({
      Email: uniqueEmail,
      AccountName: accountName,
      RoleName:
        (body.roleName as string) || "OrganizationAccountAccessRole",
      IamUserAccessToBilling:
        (body.iamUserAccessToBilling as "ALLOW" | "DENY") || "DENY",
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
