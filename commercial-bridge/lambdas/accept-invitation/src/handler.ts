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
import {
  AssumeRoleCommand,
  Credentials as StsCredentials,
  STSClient,
} from "@aws-sdk/client-sts";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";

const COMMERCIAL_REGION = "us-east-1";
const JSON_HEADERS = { "Content-Type": "application/json" };

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/**
 * Extract SigV4 credentials from an AssumeRole result, failing with a clear
 * message rather than a bare non-null-assertion TypeError if STS returns an
 * incomplete response.
 */
function toCredentials(
  creds: StsCredentials | undefined,
  step: string,
): { accessKeyId: string; secretAccessKey: string; sessionToken: string } {
  if (
    !creds?.AccessKeyId ||
    !creds.SecretAccessKey ||
    !creds.SessionToken
  ) {
    throw new Error(`AssumeRole for ${step} returned no credentials`);
  }
  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  };
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

    // 1. management → commercial linked account (commercial STS endpoint).
    const sts = new STSClient({ region: COMMERCIAL_REGION });
    const commercialCreds = await sts.send(
      new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${commercialLinkedAccountId}:role/OrganizationAccountAccessRole`,
        RoleSessionName: "BridgeToGovCloud",
      }),
    );

    // 2. commercial linked → GovCloud account.
    //
    // STS is partition-scoped: assuming a role whose ARN is in the
    // `aws-us-gov` partition MUST target a GovCloud STS endpoint. Using the
    // commercial `us-east-1` endpoint here fails — it cannot vend credentials
    // for an aws-us-gov role. The GovCloud region drives SDK endpoint
    // resolution to the correct partition. (This relies on the GovCloud
    // account's OrganizationAccountAccessRole trusting the paired commercial
    // linked account; that trust must be validated end-to-end in a real
    // GovCloud + commercial deployment.)
    const linkedSts = new STSClient({
      region: govCloudRegion,
      credentials: toCredentials(
        commercialCreds.Credentials,
        "commercial linked account",
      ),
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
      credentials: toCredentials(
        govCloudCreds.Credentials,
        "GovCloud account",
      ),
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
