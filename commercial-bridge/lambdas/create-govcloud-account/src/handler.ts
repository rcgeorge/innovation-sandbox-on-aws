// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OrganizationsClient,
  CreateGovCloudAccountCommand,
  DescribeCreateAccountStatusCommand,
  CreateAccountState,
} from "@aws-sdk/client-organizations";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const organizations = new OrganizationsClient({});

interface CreateAccountRequest {
  email: string;
  accountName: string;
  roleName?: string;
  iamUserAccessToBilling?: "ALLOW" | "DENY";
}

interface CreateAccountResponse {
  requestId: string;
  status: string;
  govCloudAccountId?: string;
  commercialAccountId?: string;
  createTime: string;
  message?: string;
}

function validateEmail(email: string): boolean {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

function createUniqueEmail(baseEmail: string): string {
  // Add timestamp-based alias to make email unique
  // e.g., "user@example.com" becomes "user+govcloud-1728252345@example.com"
  const timestamp = Date.now();
  const [localPart, domain] = baseEmail.split('@');
  return `${localPart}+govcloud-${timestamp}@${domain}`;
}

function parseRequestBody(event: APIGatewayProxyEvent): CreateAccountRequest | { error: string } {
  if (!event.body) {
    return { error: "Request body is required" };
  }

  try {
    const body = JSON.parse(event.body);

    if (!body.email || !validateEmail(body.email)) {
      return { error: "Valid email is required" };
    }

    if (!body.accountName || body.accountName.trim().length === 0) {
      return { error: "accountName is required" };
    }

    // Create unique email with alias
    const uniqueEmail = createUniqueEmail(body.email);
    console.log(`Using unique email: ${uniqueEmail} (base: ${body.email})`);

    return {
      email: uniqueEmail,
      accountName: body.accountName,
      roleName: body.roleName || "OrganizationAccountAccessRole",
      iamUserAccessToBilling: body.iamUserAccessToBilling || "DENY",
    };
  } catch (error) {
    return { error: "Invalid JSON in request body" };
  }
}

async function pollAccountStatus(
  requestId: string,
  maxAttempts: number = 60,
  delayMs: number = 5000
): Promise<CreateAccountResponse> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const command = new DescribeCreateAccountStatusCommand({
      CreateAccountRequestId: requestId,
    });

    const response = await organizations.send(command);
    const status = response.CreateAccountStatus;

    console.log(`Attempt ${attempt + 1}: Status = ${status?.State}`);

    if (status?.State === CreateAccountState.SUCCEEDED) {
      return {
        requestId,
        status: "SUCCEEDED",
        govCloudAccountId: status.GovCloudAccountId,
        commercialAccountId: status.AccountId,
        createTime: status.CompletedTimestamp?.toISOString() || new Date().toISOString(),
      };
    }

    if (status?.State === CreateAccountState.FAILED) {
      return {
        requestId,
        status: "FAILED",
        createTime: status.CompletedTimestamp?.toISOString() || new Date().toISOString(),
        message: status.FailureReason || "Account creation failed",
      };
    }

    // Still in progress, wait and retry
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // Timeout - return IN_PROGRESS status
  return {
    requestId,
    status: "IN_PROGRESS",
    createTime: new Date().toISOString(),
    message: "Account creation is still in progress. Check status using the requestId.",
  };
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log("Event:", JSON.stringify(event, null, 2));

  try {
    console.log(`HTTP Method: ${event.httpMethod}, Path: ${event.path}`);
    console.log(`Path parameters:`, JSON.stringify(event.pathParameters));

    // Check if this is a status check request using pathParameters (API Gateway extracts these)
    const requestId = event.pathParameters?.requestId || null;

    console.log(`Extracted requestId: ${requestId}`);

    // Handle listing all GovCloud accounts
    if (event.httpMethod === "GET" && !requestId) {
      console.log("Listing all GovCloud account creation requests");

      const { ListCreateAccountStatusCommand } = await import("@aws-sdk/client-organizations");
      const listCommand = new ListCreateAccountStatusCommand({
        States: [CreateAccountState.SUCCEEDED],
      });

      const listResponse = await organizations.send(listCommand);
      const accounts = (listResponse.CreateAccountStatuses || [])
        .filter(status => status.GovCloudAccountId) // Only GovCloud accounts
        .map(status => ({
          requestId: status.Id!,
          govCloudAccountId: status.GovCloudAccountId!,
          commercialAccountId: status.AccountId!,
          accountName: status.AccountName || "Unknown",
          createTime: status.CompletedTimestamp?.toISOString() || "",
        }));

      console.log(`Found ${accounts.length} GovCloud accounts`);

      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ accounts }),
      };
    }

    // Handle status check for specific request
    if (event.httpMethod === "GET" && requestId) {
      console.log(`Checking status for request: ${requestId}`);

      const command = new DescribeCreateAccountStatusCommand({
        CreateAccountRequestId: requestId,
      });

      const response = await organizations.send(command);
      const status = response.CreateAccountStatus;

      const responseBody: CreateAccountResponse = {
        requestId,
        status: status?.State || "UNKNOWN",
        govCloudAccountId: status?.GovCloudAccountId,
        commercialAccountId: status?.AccountId,
        createTime: status?.CompletedTimestamp?.toISOString() || new Date().toISOString(),
        message: status?.State === CreateAccountState.FAILED ? status.FailureReason : undefined,
      };

      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify(responseBody),
      };
    }

    // Handle create account request
    if (event.httpMethod === "POST") {
      const requestBody = parseRequestBody(event);
      if ("error" in requestBody) {
        return {
          statusCode: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({ error: requestBody.error }),
        };
      }

      const { email, accountName, roleName, iamUserAccessToBilling } = requestBody;

      console.log(`Creating GovCloud account: ${accountName} (${email})`);

      // Initiate account creation
      const command = new CreateGovCloudAccountCommand({
        Email: email,
        AccountName: accountName,
        RoleName: roleName,
        IamUserAccessToBilling: iamUserAccessToBilling,
      });

      const response = await organizations.send(command);
      const createRequestId = response.CreateAccountStatus?.Id;

      if (!createRequestId) {
        throw new Error("Failed to get create account request ID");
      }

      console.log(`Account creation initiated: ${createRequestId}`);

      // Return immediately with requestId - user can poll /govcloud-accounts/{requestId} for status
      // Account creation typically takes 5-30 minutes, too long for API Gateway 29s timeout
      const result: CreateAccountResponse = {
        requestId: createRequestId,
        status: "IN_PROGRESS",
        createTime: new Date().toISOString(),
        message: "Account creation initiated. Check status using GET /govcloud-accounts/{requestId}",
      };

      return {
        statusCode: 202,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify(result),
      };
    }

    // Invalid method
    return {
      statusCode: 405,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (error) {
    console.error("Error creating GovCloud account:", error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Failed to create GovCloud account",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
};
