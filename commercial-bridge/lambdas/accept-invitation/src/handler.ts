// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Accepts a GovCloud Organizations handshake on behalf of a paired GovCloud
 * account. When CreateGovCloudAccount creates the account pair, the commercial
 * management account can assume OrganizationAccountAccessRole in the commercial
 * linked account, and — via the special linked-account relationship — that in
 * turn can assume the same role cross-partition in the GovCloud account. Those
 * GovCloud credentials are then used to accept the org invitation.
 *
 *   POST /govcloud-accounts/accept-invitation
 *     { govCloudAccountId, handshakeId, govCloudRegion, commercialLinkedAccountId }
 */
import {
  AcceptHandshakeCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";

const COMMERCIAL_REGION = "us-east-1";
const JSON_HEADERS = { "Content-Type": "application/json" };

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

interface AcceptInvitationRequest {
  govCloudAccountId: string;
  handshakeId: string;
  govCloudRegion: string;
  commercialLinkedAccountId: string;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    if (!event.body) {
      return response(400, { error: "Request body is required" });
    }

    let body: AcceptInvitationRequest;
    try {
      body = JSON.parse(event.body);
    } catch {
      return response(400, { error: "Invalid JSON in request body" });
    }

    const {
      govCloudAccountId,
      handshakeId,
      govCloudRegion,
      commercialLinkedAccountId,
    } = body;
    if (
      !govCloudAccountId ||
      !handshakeId ||
      !govCloudRegion ||
      !commercialLinkedAccountId
    ) {
      return response(400, {
        error:
          "govCloudAccountId, handshakeId, govCloudRegion and commercialLinkedAccountId are required",
      });
    }

    const sts = new STSClient({ region: COMMERCIAL_REGION });

    // 1. management → commercial linked account.
    const commercialCreds = await sts.send(
      new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${commercialLinkedAccountId}:role/OrganizationAccountAccessRole`,
        RoleSessionName: "BridgeToGovCloud",
      }),
    );

    // 2. commercial linked → GovCloud account (cross-partition).
    const linkedSts = new STSClient({
      region: COMMERCIAL_REGION,
      credentials: {
        accessKeyId: commercialCreds.Credentials!.AccessKeyId!,
        secretAccessKey: commercialCreds.Credentials!.SecretAccessKey!,
        sessionToken: commercialCreds.Credentials!.SessionToken!,
      },
    });
    const govCloudCreds = await linkedSts.send(
      new AssumeRoleCommand({
        RoleArn: `arn:aws-us-gov:iam::${govCloudAccountId}:role/OrganizationAccountAccessRole`,
        RoleSessionName: "AcceptOrgInvitation",
      }),
    );

    // 3. accept the handshake with GovCloud credentials.
    const govCloudOrgs = new OrganizationsClient({
      region: govCloudRegion,
      credentials: {
        accessKeyId: govCloudCreds.Credentials!.AccessKeyId!,
        secretAccessKey: govCloudCreds.Credentials!.SecretAccessKey!,
        sessionToken: govCloudCreds.Credentials!.SessionToken!,
      },
    });
    const accepted = await govCloudOrgs.send(
      new AcceptHandshakeCommand({ HandshakeId: handshakeId }),
    );

    return response(200, {
      status: "ACCEPTED",
      handshakeId,
      govCloudAccountId,
      handshakeState: accepted.Handshake?.State,
    });
  } catch (error) {
    return response(500, {
      error: "Failed to accept invitation",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
