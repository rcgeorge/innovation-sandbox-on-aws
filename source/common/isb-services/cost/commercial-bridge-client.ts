// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Sha256 } from "@aws-crypto/sha256-js";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { execFileSync } from "child_process";
import { existsSync, unlinkSync, writeFileSync } from "fs";

// Commercial partition region the bridge API is deployed in. SigV4 signing and
// Roles Anywhere both operate against the commercial partition.
const COMMERCIAL_REGION = "us-east-1";
const CRED_HELPER_PATH = "/opt/bin/aws_signing_helper";

export interface RolesAnywhereConfig {
  clientCertSecretArn: string;
  trustAnchorArn: string;
  profileArn: string;
  roleArn: string;
}

export interface CommercialBridgeCostRequest {
  linkedAccountId: string;
  startDate: string;
  endDate: string;
  granularity?: "DAILY" | "MONTHLY";
  region?: string;
  isGovCloudAccountId?: boolean;
  commercialAccountId?: string;
}

export interface CommercialBridgeCostResponse {
  linkedAccountId: string;
  govCloudAccountId?: string;
  commercialAccountId?: string;
  totalCost: number;
  currency: string;
  breakdown: Array<{ service: string; cost: number }>;
}

export interface CreateGovCloudAccountRequest {
  accountName: string;
  email: string;
  roleName?: string;
}

export interface CreateGovCloudAccountResponse {
  requestId: string;
  status: string;
  message?: string;
}

export interface GovCloudAccountStatusResponse {
  requestId: string;
  status: string; // IN_PROGRESS | SUCCEEDED | FAILED | UNKNOWN
  govCloudAccountId?: string;
  commercialAccountId?: string;
  message?: string;
}

export interface AcceptInvitationRequest {
  govCloudAccountId: string;
  handshakeId: string;
  govCloudRegion: string;
  commercialLinkedAccountId: string;
}

export interface AcceptInvitationResponse {
  status: string;
  handshakeId: string;
  govCloudAccountId: string;
  handshakeState?: string;
}

interface RolesAnywhereCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  Expiration: string;
}

export class CommercialBridgeApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommercialBridgeApiError";
  }
}

export class CommercialBridgeAccountMappingNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommercialBridgeAccountMappingNotFoundError";
  }
}

/**
 * Client for the cross-partition commercial bridge API. Authenticates with IAM
 * Roles Anywhere (certificate-based SigV4) only — the legacy API-key mode is
 * intentionally not supported.
 */
export class CommercialBridgeClient {
  private credentialsCache: RolesAnywhereCredentials | null = null;
  private readonly secretsManagerClient: SecretsManagerClient;

  constructor(
    private readonly apiUrl: string,
    private readonly rolesAnywhereConfig: RolesAnywhereConfig,
  ) {
    this.secretsManagerClient = new SecretsManagerClient({});
  }

  async queryCost(
    params: CommercialBridgeCostRequest,
  ): Promise<CommercialBridgeCostResponse> {
    const response = await this.makeSignedRequest("POST", "/cost-info", params);

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 404) {
        throw new CommercialBridgeAccountMappingNotFoundError(
          `No commercial account mapping found for account ${params.linkedAccountId}`,
        );
      }
      throw new CommercialBridgeApiError(
        `Commercial bridge API request failed: ${response.status} ${response.statusText} ${errorBody}`,
      );
    }

    return (await response.json()) as CommercialBridgeCostResponse;
  }

  /**
   * Initiate creation of a paired GovCloud + commercial account. Returns
   * immediately with a requestId to poll via getGovCloudAccountStatus.
   */
  async createGovCloudAccount(
    params: CreateGovCloudAccountRequest,
  ): Promise<CreateGovCloudAccountResponse> {
    const response = await this.makeSignedRequest(
      "POST",
      "/govcloud-accounts",
      params,
    );
    if (!response.ok) {
      throw new CommercialBridgeApiError(
        `Failed to create GovCloud account: ${response.status} ${await response.text()}`,
      );
    }
    return (await response.json()) as CreateGovCloudAccountResponse;
  }

  /** Poll the status of a GovCloud account-creation request. */
  async getGovCloudAccountStatus(
    requestId: string,
  ): Promise<GovCloudAccountStatusResponse> {
    const response = await this.makeSignedRequest(
      "GET",
      `/govcloud-accounts/${encodeURIComponent(requestId)}`,
    );
    if (!response.ok) {
      throw new CommercialBridgeApiError(
        `Failed to get GovCloud account status: ${response.status}`,
      );
    }
    return (await response.json()) as GovCloudAccountStatusResponse;
  }

  /** Accept a GovCloud org invitation via the cross-partition bridge. */
  async acceptInvitation(
    params: AcceptInvitationRequest,
  ): Promise<AcceptInvitationResponse> {
    const response = await this.makeSignedRequest(
      "POST",
      "/govcloud-accounts/accept-invitation",
      params,
    );
    if (!response.ok) {
      throw new CommercialBridgeApiError(
        `Failed to accept invitation: ${response.status} ${await response.text()}`,
      );
    }
    return (await response.json()) as AcceptInvitationResponse;
  }

  private async makeSignedRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const credentials = await this.getRolesAnywhereCredentials();
    const url = new URL(`${this.apiUrl}${path}`);

    const request = new HttpRequest({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        host: url.hostname,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const signer = new SignatureV4({
      credentials: {
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
      },
      region: COMMERCIAL_REGION,
      service: "execute-api",
      sha256: Sha256,
    });

    const signed = await signer.sign(request);
    const signedHeaders = (signed as { headers: Record<string, string> })
      .headers;

    return fetch(url.toString(), {
      method,
      headers: signedHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private async getRolesAnywhereCredentials(): Promise<RolesAnywhereCredentials> {
    // Reuse cached credentials until 5 minutes before expiry.
    if (this.credentialsCache) {
      const expiresAt = new Date(this.credentialsCache.Expiration).getTime();
      if (expiresAt - new Date().getTime() > 5 * 60 * 1000) {
        return this.credentialsCache;
      }
    }

    if (!existsSync(CRED_HELPER_PATH)) {
      throw new Error(
        "AWS Roles Anywhere credential helper not found at " +
          `${CRED_HELPER_PATH}. Ensure the roles-anywhere-helper Lambda layer ` +
          "is attached to this function.",
      );
    }

    const { cert, key } = await this.getClientCertificate();
    const certPath = "/tmp/commercial-bridge-client.pem";
    const keyPath = "/tmp/commercial-bridge-client.key";

    try {
      writeFileSync(certPath, Buffer.from(cert, "base64"), { mode: 0o600 });
      writeFileSync(keyPath, Buffer.from(key, "base64"), { mode: 0o600 });

      const credJson = execFileSync(
        CRED_HELPER_PATH,
        [
          "credential-process",
          "--certificate",
          certPath,
          "--private-key",
          keyPath,
          "--trust-anchor-arn",
          this.rolesAnywhereConfig.trustAnchorArn,
          "--profile-arn",
          this.rolesAnywhereConfig.profileArn,
          "--role-arn",
          this.rolesAnywhereConfig.roleArn,
        ],
        { encoding: "utf-8" },
      );

      const credentials = JSON.parse(credJson) as RolesAnywhereCredentials;
      this.credentialsCache = credentials;
      return credentials;
    } finally {
      if (existsSync(certPath)) unlinkSync(certPath);
      if (existsSync(keyPath)) unlinkSync(keyPath);
    }
  }

  private async getClientCertificate(): Promise<{ cert: string; key: string }> {
    const response = await this.secretsManagerClient.send(
      new GetSecretValueCommand({
        SecretId: this.rolesAnywhereConfig.clientCertSecretArn,
      }),
    );

    if (!response.SecretString) {
      throw new Error(
        `Client certificate secret is empty: ${this.rolesAnywhereConfig.clientCertSecretArn}`,
      );
    }

    const { cert, key } = JSON.parse(response.SecretString);
    if (!cert || !key) {
      throw new Error(
        "Client certificate secret must contain base64 'cert' and 'key' fields",
      );
    }
    return { cert, key };
  }
}
