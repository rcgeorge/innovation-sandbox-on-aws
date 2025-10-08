// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import { LeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template-store.js";
import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";
import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import { CommercialBridgeCostService } from "@amzn/innovation-sandbox-commons/isb-services/commercial-bridge-cost-service.js";
import { ICostService } from "@amzn/innovation-sandbox-commons/isb-services/cost-service.js";
import { CostExplorerService } from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import {
  LogArchivingService,
  LogArchivingServiceProps,
} from "@amzn/innovation-sandbox-commons/isb-services/log-archiving-service.js";
import {
  EmailService,
  EmailServiceProps,
} from "@amzn/innovation-sandbox-commons/isb-services/notification/email-service.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import {
  AwsCredentialIdentity,
  AwsCredentialIdentityProvider,
} from "@aws-sdk/types";

export namespace ServiceEnv {
  export type leaseStore = {
    LEASE_TABLE_NAME: string;
    USER_AGENT_EXTRA: string;
  };

  export type sandboxAccountStore = {
    ACCOUNT_TABLE_NAME: string;
    USER_AGENT_EXTRA: string;
  };

  export type leaseTemplateStore = {
    LEASE_TEMPLATE_TABLE_NAME: string;
    USER_AGENT_EXTRA: string;
  };

  export type isbEventBridge = {
    USER_AGENT_EXTRA: string;
    ISB_EVENT_BUS: string;
    ISB_NAMESPACE: string;
  };

  export type idcService = {
    ISB_NAMESPACE: string;
    USER_AGENT_EXTRA: string;
  };

  export type orgsService = {
    ISB_NAMESPACE: string;
    ACCOUNT_TABLE_NAME: string;
    SANDBOX_OU_ID: string;
    USER_AGENT_EXTRA: string;
  };

  export type costExplorer = {
    USER_AGENT_EXTRA: string;
    AWS_REGIONS?: string;
    COMMERCIAL_BRIDGE_API_URL?: string;
    COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN?: string;
    // IAM Roles Anywhere configuration (optional)
    COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN?: string;
    COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN?: string;
    COMMERCIAL_BRIDGE_PROFILE_ARN?: string;
    COMMERCIAL_BRIDGE_ROLE_ARN?: string;
  } & Partial<sandboxAccountStore>; // Only needed for GovCloud commercial bridge

  export type emailService = {
    ISB_NAMESPACE: string;
    IDC_ROLE_ARN: string;
    INTERMEDIATE_ROLE_ARN: string;
    USER_AGENT_EXTRA: string;
  } & idcService;

  export type logArchivingService = {
    USER_AGENT_EXTRA: string;
  };
}

/**
 * typed factories that extract relevant pieces of an environment json to build each service
 */
export class IsbServices {
  private constructor() {
    //static class. Shouldn't be constructable
  }

  public static leaseStore(env: ServiceEnv.leaseStore): LeaseStore {
    return new DynamoLeaseStore({
      client: IsbClients.dynamo(env),
      leaseTableName: env.LEASE_TABLE_NAME,
    });
  }

  public static sandboxAccountStore(
    env: ServiceEnv.sandboxAccountStore,
  ): SandboxAccountStore {
    return new DynamoSandboxAccountStore({
      client: IsbClients.dynamo(env),
      accountTableName: env.ACCOUNT_TABLE_NAME,
    });
  }

  public static leaseTemplateStore(
    env: ServiceEnv.leaseTemplateStore,
  ): LeaseTemplateStore {
    return new DynamoLeaseTemplateStore({
      client: IsbClients.dynamo(env),
      leaseTemplateTableName: env.LEASE_TEMPLATE_TABLE_NAME,
    });
  }

  public static isbEventBridge(
    env: ServiceEnv.isbEventBridge,
  ): IsbEventBridgeClient {
    return IsbClients.eventBridge(
      {
        eventSource: `InnovationSandbox-${env.ISB_NAMESPACE}`,
      },
      env,
    );
  }

  public static idcService(
    env: ServiceEnv.idcService,
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ) {
    return new IdcService({
      namespace: env.ISB_NAMESPACE,
      ssmClient: IsbClients.ssm(env, credentials),
      ssoAdminClient: IsbClients.ssoAdmin(env, credentials),
      identityStoreClient: IsbClients.identityStore(env, credentials),
    });
  }

  public static orgsService(
    env: ServiceEnv.orgsService,
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ) {
    return new SandboxOuService({
      namespace: env.ISB_NAMESPACE,
      sandboxAccountStore: IsbServices.sandboxAccountStore(env),
      sandboxOuId: env.SANDBOX_OU_ID,
      orgsClient: IsbClients.orgs(env, credentials),
    });
  }

  public static costExplorer(
    env: ServiceEnv.costExplorer,
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): ICostService {
    // Detect if this is a GovCloud deployment
    const regions = env.AWS_REGIONS?.split(",") || [];
    const isGovCloud = regions.some((r) => r.startsWith("us-gov-"));

    // Use commercial bridge for GovCloud if configured
    // Supports both API Key and IAM Roles Anywhere authentication
    const hasApiKeyAuth = env.COMMERCIAL_BRIDGE_API_URL && env.COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN;
    const hasRolesAnywhereAuth = env.COMMERCIAL_BRIDGE_API_URL &&
      env.COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN &&
      env.COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN &&
      env.COMMERCIAL_BRIDGE_PROFILE_ARN &&
      env.COMMERCIAL_BRIDGE_ROLE_ARN;

    if (isGovCloud && (hasApiKeyAuth || hasRolesAnywhereAuth) && env.ACCOUNT_TABLE_NAME) {
      return new CommercialBridgeCostService({
        commercialBridgeEnv: env as any, // Pass full env, factory will determine auth mode
        govCloudRegions: regions.filter((r) => r.startsWith("us-gov-")),
        sandboxAccountStore: IsbServices.sandboxAccountStore(env as ServiceEnv.sandboxAccountStore),
      });
    }

    // Default: Use Cost Explorer SDK (commercial AWS)
    return new CostExplorerService({
      costExplorerClient: IsbClients.costExplorer(env, credentials),
    });
  }

  public static emailService(
    env: ServiceEnv.emailService,
    props: EmailServiceProps,
  ) {
    return new EmailService(env, props);
  }

  public static logArchivingService(
    env: ServiceEnv.logArchivingService,
    props: LogArchivingServiceProps,
  ) {
    return new LogArchivingService(env, props);
  }
}
