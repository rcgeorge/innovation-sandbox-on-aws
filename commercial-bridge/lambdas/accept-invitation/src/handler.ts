// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OrganizationsClient,
  AcceptHandshakeCommand,
} from "@aws-sdk/client-organizations";
import {
  STSClient,
  AssumeRoleCommand,
} from "@aws-sdk/client-sts";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const stsClient = new STSClient({ region: "us-east-1" });

interface AcceptInvitationRequest {
  govCloudAccountId: string;
  handshakeId: string;
  govCloudRegion: string;
  commercialLinkedAccountId: string;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log("Event:", JSON.stringify(event, null, 2));

  try {
    if (!event.body) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "Request body is required"
        }),
      };
    }

    const body: AcceptInvitationRequest = JSON.parse(event.body);

    if (!body.govCloudAccountId || !body.handshakeId || !body.govCloudRegion || !body.commercialLinkedAccountId) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "govCloudAccountId, handshakeId, govCloudRegion, and commercialLinkedAccountId are required"
        }),
      };
    }

    const govCloudAccountId = body.govCloudAccountId;

    console.log(`Accepting GovCloud org invitation for account ${govCloudAccountId}`);
    console.log(`Using commercial linked account: ${body.commercialLinkedAccountId}`);
    console.log(`Handshake ID: ${body.handshakeId}`);

    // Step 1: Assume OrganizationAccountAccessRole in commercial linked account
    console.log("Step 1: Assuming role in commercial linked account...");
    const commercialRoleArn = `arn:aws:iam::${body.commercialLinkedAccountId}:role/OrganizationAccountAccessRole`;

    const commercialCredentials = await stsClient.send(
      new AssumeRoleCommand({
        RoleArn: commercialRoleArn,
        RoleSessionName: "BridgeToGovCloud"
      })
    );

    console.log("Successfully assumed role in commercial linked account");

    // Step 2: Use commercial credentials to assume role in GovCloud account
    // This works due to the special relationship between linked accounts!
    console.log("Step 2: Assuming role in GovCloud account using commercial credentials...");
    const govCloudRoleArn = `arn:aws-us-gov:iam::${govCloudAccountId}:role/OrganizationAccountAccessRole`;

    // Create STS client with commercial linked account credentials
    const commercialLinkedSTS = new STSClient({
      region: "us-east-1",
      credentials: {
        accessKeyId: commercialCredentials.Credentials!.AccessKeyId!,
        secretAccessKey: commercialCredentials.Credentials!.SecretAccessKey!,
        sessionToken: commercialCredentials.Credentials!.SessionToken!
      }
    });

    const govCloudCredentials = await commercialLinkedSTS.send(
      new AssumeRoleCommand({
        RoleArn: govCloudRoleArn,
        RoleSessionName: "AcceptOrgInvitation"
      })
    );

    console.log("Successfully assumed role in GovCloud account");

    // Step 3: Create GovCloud Organizations client with GovCloud credentials
    console.log("Step 3: Accepting handshake in GovCloud...");
    const govCloudOrgsClient = new OrganizationsClient({
      region: body.govCloudRegion,
      credentials: {
        accessKeyId: govCloudCredentials.Credentials!.AccessKeyId!,
        secretAccessKey: govCloudCredentials.Credentials!.SecretAccessKey!,
        sessionToken: govCloudCredentials.Credentials!.SessionToken!
      }
    });

    // Step 4: Accept handshake
    const acceptResponse = await govCloudOrgsClient.send(
      new AcceptHandshakeCommand({
        HandshakeId: body.handshakeId
      })
    );

    console.log("Successfully accepted handshake");
    console.log("Handshake state:", acceptResponse.Handshake?.State);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        status: "ACCEPTED",
        handshakeId: body.handshakeId,
        govCloudAccountId: govCloudAccountId,
        handshakeState: acceptResponse.Handshake?.State
      }),
    };
  } catch (error) {
    console.error("Error accepting invitation:", error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Failed to accept invitation",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
};
