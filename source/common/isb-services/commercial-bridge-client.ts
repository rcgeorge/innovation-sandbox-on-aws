// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";

const logger = new Logger({ serviceName: "CommercialBridgeClient" });

interface CommercialBridgeCostRequest {
  linkedAccountId: string;
  startDate: string;
  endDate: string;
  granularity?: "DAILY" | "MONTHLY";
  region?: string;
  isGovCloudAccountId?: boolean;
  commercialAccountId?: string;
}

interface CommercialBridgeCostResponse {
  linkedAccountId: string;
  govCloudAccountId?: string;
  commercialAccountId?: string;
  startDate: string;
  endDate: string;
  totalCost: number;
  currency: string;
  breakdown: Array<{
    service: string;
    cost: number;
  }>;
}

interface CreateGovCloudAccountRequest {
  accountName: string;
  email: string;
  roleName?: string;
}

interface CreateGovCloudAccountResponse {
  requestId: string;
  status: string;
  createTime: string;
  message?: string;
}

interface GovCloudAccountStatusResponse {
  requestId: string;
  status: string;
  govCloudAccountId?: string;
  commercialAccountId?: string;
  createTime: string;
  message?: string;
}

export interface GovCloudAccountListItem {
  requestId: string;
  govCloudAccountId: string;
  commercialAccountId: string;
  accountName: string;
  createTime: string;
}

export interface ListGovCloudAccountsResponse {
  accounts: GovCloudAccountListItem[];
}

interface AcceptInvitationRequest {
  handshakeId: string;
  govCloudRegion: string;
  commercialLinkedAccountId: string;
}

interface AcceptInvitationResponse {
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

interface IAMRolesAnywhereConfig {
  clientCertSecretArn: string;
  trustAnchorArn: string;
  profileArn: string;
  roleArn: string;
}

/**
 * Client for Commercial Bridge API
 * Supports two authentication modes:
 * 1. API Key (legacy) - Pass apiKeySecretArn
 * 2. IAM Roles Anywhere (recommended) - Pass rolesAnywhereConfig
 */
export class CommercialBridgeClient {
  private apiKeyCache: string | null = null;
  private credentialsCache: RolesAnywhereCredentials | null = null;
  private readonly secretsManagerClient: SecretsManagerClient;
  private readonly authMode: "API_KEY" | "IAM_ROLES_ANYWHERE";

  constructor(
    private readonly apiUrl: string,
    private readonly apiKeySecretArn?: string,
    private readonly rolesAnywhereConfig?: IAMRolesAnywhereConfig,
  ) {
    this.secretsManagerClient = new SecretsManagerClient({});

    // Determine auth mode
    if (rolesAnywhereConfig) {
      this.authMode = "IAM_ROLES_ANYWHERE";
      logger.info("CommercialBridgeClient using IAM Roles Anywhere authentication");
    } else if (apiKeySecretArn) {
      this.authMode = "API_KEY";
      logger.info("CommercialBridgeClient using API Key authentication");
    } else {
      throw new Error(
        "CommercialBridgeClient requires either apiKeySecretArn or rolesAnywhereConfig",
      );
    }
  }

  async queryCost(
    params: CommercialBridgeCostRequest,
  ): Promise<CommercialBridgeCostResponse> {
    logger.debug("Querying commercial bridge cost API", {
      accountId: params.linkedAccountId,
      isGovCloudAccount: params.isGovCloudAccountId,
      region: params.region,
    });

    const response = await this.makeRequest("POST", "/cost-info", params);

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error("Commercial bridge API error", {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });

      if (response.status === 404) {
        throw new CommercialBridgeAccountMappingNotFoundError(
          `No commercial account mapping found for GovCloud account ${params.linkedAccountId}`,
        );
      }

      throw new CommercialBridgeApiError(
        `Commercial bridge API request failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as CommercialBridgeCostResponse;
    logger.debug("Commercial bridge cost response", {
      totalCost: data.totalCost,
      govCloudAccountId: data.govCloudAccountId,
      commercialAccountId: data.commercialAccountId,
    });

    return data;
  }

  async createGovCloudAccount(
    params: CreateGovCloudAccountRequest,
  ): Promise<CreateGovCloudAccountResponse> {
    logger.info("Creating new GovCloud account via commercial bridge", {
      accountName: params.accountName,
      email: params.email,
    });

    const response = await this.makeRequest(
      "POST",
      "/govcloud-accounts",
      params,
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new CommercialBridgeApiError(
        `Failed to create GovCloud account: ${response.status} ${errorBody}`,
      );
    }

    return (await response.json()) as CreateGovCloudAccountResponse;
  }

  async listGovCloudAccounts(): Promise<ListGovCloudAccountsResponse> {
    logger.debug("Listing all GovCloud accounts from commercial bridge");

    const response = await this.makeRequest("GET", "/govcloud-accounts");

    if (!response.ok) {
      throw new CommercialBridgeApiError(
        `Failed to list GovCloud accounts: ${response.status}`,
      );
    }

    return (await response.json()) as ListGovCloudAccountsResponse;
  }

  async getGovCloudAccountStatus(
    requestId: string,
  ): Promise<GovCloudAccountStatusResponse> {
    logger.debug("Checking GovCloud account creation status", { requestId });

    const response = await this.makeRequest(
      "GET",
      `/govcloud-accounts/${requestId}`,
    );

    if (!response.ok) {
      throw new CommercialBridgeApiError(
        `Failed to get account status: ${response.status}`,
      );
    }

    return (await response.json()) as GovCloudAccountStatusResponse;
  }

  async acceptInvitation(
    params: AcceptInvitationRequest & { govCloudAccountId: string },
  ): Promise<AcceptInvitationResponse> {
    logger.info("Requesting commercial bridge to accept GovCloud org invitation", {
      govCloudAccountId: params.govCloudAccountId,
      handshakeId: params.handshakeId,
    });

    const response = await this.makeRequest(
      "POST",
      "/govcloud-accounts/accept-invitation",
      {
        govCloudAccountId: params.govCloudAccountId,
        handshakeId: params.handshakeId,
        govCloudRegion: params.govCloudRegion,
        commercialLinkedAccountId: params.commercialLinkedAccountId,
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new CommercialBridgeApiError(
        `Failed to accept invitation: ${response.status} ${errorBody}`,
      );
    }

    return (await response.json()) as AcceptInvitationResponse;
  }

  /**
   * Make HTTP request with appropriate authentication
   */
  private async makeRequest(
    method: string,
    path: string,
    body?: any,
  ): Promise<Response> {
    if (this.authMode === "API_KEY") {
      return this.makeApiKeyRequest(method, path, body);
    } else {
      return this.makeIAMRequest(method, path, body);
    }
  }

  /**
   * Make request using API Key authentication
   */
  private async makeApiKeyRequest(
    method: string,
    path: string,
    body?: any,
  ): Promise<Response> {
    const apiKey = await this.getApiKey();

    const headers: Record<string, string> = {
      "x-api-key": apiKey,
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    return fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Make request using IAM SigV4 signed request (IAM Roles Anywhere)
   */
  private async makeIAMRequest(
    method: string,
    path: string,
    body?: any,
  ): Promise<Response> {
    const credentials = await this.getRolesAnywhereCredentials();

    // Parse API URL
    const url = new URL(`${this.apiUrl}${path}`);

    // Create HTTP request
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

    // Sign request with SigV4
    const signer = new SignatureV4({
      credentials: {
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
      },
      region: "us-east-1", // Commercial region
      service: "execute-api",
      sha256: Sha256,
    });

    const signedRequest = await signer.sign(request);

    // Make request with signed headers
    return fetch(`${this.apiUrl}${path}`, {
      method,
      headers: signedRequest.headers as Record<string, string>,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Get temporary credentials using IAM Roles Anywhere credential helper
   */
  private async getRolesAnywhereCredentials(): Promise<RolesAnywhereCredentials> {
    // Check if cached credentials are still valid (with 5 minute buffer)
    if (this.credentialsCache) {
      const expirationTime = new Date(this.credentialsCache.Expiration).getTime();
      const now = Date.now();
      const bufferMs = 5 * 60 * 1000; // 5 minutes

      if (expirationTime - now > bufferMs) {
        logger.debug("Using cached IAM Roles Anywhere credentials");
        return this.credentialsCache;
      }
    }

    logger.debug("Fetching new IAM Roles Anywhere credentials");

    // Get client certificate from Secrets Manager
    const { cert, key } = await this.getClientCertificate();

    // Write cert and key to /tmp
    const certPath = "/tmp/commercial-bridge-client.pem";
    const keyPath = "/tmp/commercial-bridge-client.key";

    try {
      writeFileSync(certPath, Buffer.from(cert, "base64"));
      writeFileSync(keyPath, Buffer.from(key, "base64"));

      // Call credential helper
      const credHelperPath = "/opt/bin/aws_signing_helper";

      if (!existsSync(credHelperPath)) {
        throw new Error(
          "AWS Roles Anywhere credential helper not found. " +
          "Ensure the roles-anywhere-helper Lambda layer is attached.",
        );
      }

      const credJson = execSync(
        `${credHelperPath} credential-process ` +
        `--certificate ${certPath} ` +
        `--private-key ${keyPath} ` +
        `--trust-anchor-arn ${this.rolesAnywhereConfig!.trustAnchorArn} ` +
        `--profile-arn ${this.rolesAnywhereConfig!.profileArn} ` +
        `--role-arn ${this.rolesAnywhereConfig!.roleArn}`,
        { encoding: "utf-8" },
      );

      const credentials = JSON.parse(credJson) as RolesAnywhereCredentials;
      this.credentialsCache = credentials;

      logger.debug("IAM Roles Anywhere credentials obtained", {
        expiration: credentials.Expiration,
      });

      return credentials;
    } finally {
      // Clean up temp files
      if (existsSync(certPath)) unlinkSync(certPath);
      if (existsSync(keyPath)) unlinkSync(keyPath);
    }
  }

  /**
   * Get client certificate from Secrets Manager
   */
  private async getClientCertificate(): Promise<{ cert: string; key: string }> {
    logger.debug("Retrieving client certificate from Secrets Manager", {
      secretArn: this.rolesAnywhereConfig!.clientCertSecretArn,
    });

    const response = await this.secretsManagerClient.send(
      new GetSecretValueCommand({
        SecretId: this.rolesAnywhereConfig!.clientCertSecretArn,
      }),
    );

    if (!response.SecretString) {
      throw new Error(
        `Failed to retrieve client certificate from Secrets Manager: ${this.rolesAnywhereConfig!.clientCertSecretArn}`,
      );
    }

    const { cert, key } = JSON.parse(response.SecretString);

    if (!cert || !key) {
      throw new Error(
        "Client certificate secret must contain 'cert' and 'key' fields (base64 encoded)",
      );
    }

    return { cert, key };
  }

  /**
   * Get API key from Secrets Manager (legacy auth mode)
   */
  private async getApiKey(): Promise<string> {
    if (this.apiKeyCache) {
      return this.apiKeyCache;
    }

    logger.debug("Retrieving commercial bridge API key from Secrets Manager", {
      secretArn: this.apiKeySecretArn,
    });

    const response = await this.secretsManagerClient.send(
      new GetSecretValueCommand({
        SecretId: this.apiKeySecretArn!,
      }),
    );

    if (!response.SecretString) {
      throw new Error(
        `Failed to retrieve API key from Secrets Manager: ${this.apiKeySecretArn}`,
      );
    }

    this.apiKeyCache = response.SecretString;
    return this.apiKeyCache;
  }
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
