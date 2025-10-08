// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

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

export class CommercialBridgeClient {
  private apiKeyCache: string | null = null;
  private readonly secretsManagerClient: SecretsManagerClient;

  constructor(
    private readonly apiUrl: string,
    private readonly apiKeySecretArn: string,
  ) {
    this.secretsManagerClient = new SecretsManagerClient({});
  }

  async queryCost(
    params: CommercialBridgeCostRequest,
  ): Promise<CommercialBridgeCostResponse> {
    const apiKey = await this.getApiKey();

    logger.debug("Querying commercial bridge cost API", {
      accountId: params.linkedAccountId,
      isGovCloudAccount: params.isGovCloudAccountId,
      region: params.region,
    });

    const response = await fetch(`${this.apiUrl}/cost-info`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(params),
    });

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
    const apiKey = await this.getApiKey();

    logger.info("Creating new GovCloud account via commercial bridge", {
      accountName: params.accountName,
      email: params.email,
    });

    const response = await fetch(`${this.apiUrl}/govcloud-accounts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new CommercialBridgeApiError(
        `Failed to create GovCloud account: ${response.status} ${errorBody}`,
      );
    }

    return (await response.json()) as CreateGovCloudAccountResponse;
  }

  async listGovCloudAccounts(): Promise<ListGovCloudAccountsResponse> {
    const apiKey = await this.getApiKey();

    logger.debug("Listing all GovCloud accounts from commercial bridge");

    const response = await fetch(`${this.apiUrl}/govcloud-accounts`, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
      },
    });

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
    const apiKey = await this.getApiKey();

    logger.debug("Checking GovCloud account creation status", { requestId });

    const response = await fetch(
      `${this.apiUrl}/govcloud-accounts/${requestId}`,
      {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
        },
      },
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
    const apiKey = await this.getApiKey();

    logger.info("Requesting commercial bridge to accept GovCloud org invitation", {
      govCloudAccountId: params.govCloudAccountId,
      handshakeId: params.handshakeId,
    });

    const response = await fetch(
      `${this.apiUrl}/govcloud-accounts/accept-invitation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          govCloudAccountId: params.govCloudAccountId,
          handshakeId: params.handshakeId,
          govCloudRegion: params.govCloudRegion,
          commercialLinkedAccountId: params.commercialLinkedAccountId,
        }),
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

  private async getApiKey(): Promise<string> {
    if (this.apiKeyCache) {
      return this.apiKeyCache;
    }

    logger.debug("Retrieving commercial bridge API key from Secrets Manager", {
      secretArn: this.apiKeySecretArn,
    });

    const response = await this.secretsManagerClient.send(
      new GetSecretValueCommand({
        SecretId: this.apiKeySecretArn,
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
