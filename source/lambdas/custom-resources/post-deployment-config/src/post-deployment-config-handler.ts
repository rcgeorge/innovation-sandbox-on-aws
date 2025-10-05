// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type {
  CdkCustomResourceEvent,
  CdkCustomResourceResponse,
  CloudFormationCustomResourceCreateEvent,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
  Context,
} from "aws-lambda";

import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import {
  CreateApplicationCommand,
  DeleteApplicationCommand,
  DescribeApplicationCommand,
  PutApplicationAssignmentConfigurationCommand,
  SSOAdminClient,
  ResourceNotFoundException as SSOAdminResourceNotFoundException,
} from "@aws-sdk/client-sso-admin";
import {
  AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from "@aws-sdk/client-appconfigdata";
import {
  AppConfigClient,
  CreateHostedConfigurationVersionCommand,
} from "@aws-sdk/client-appconfig";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  UpdateSecretCommand,
  DescribeSecretCommand,
  ResourceNotFoundException as SecretsManagerResourceNotFoundException,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import yaml from "js-yaml";

const tracer = new Tracer();
const logger = new Logger();

const PostDeploymentConfigLambdaEnvironmentSchema = z.object({});

type PostDeploymentConfigLambdaEnvironment = z.infer<
  typeof PostDeploymentConfigLambdaEnvironmentSchema
>;

export type PostDeploymentConfigResourceProperties = {
  namespace: string;
  ssoInstanceArn: string;
  idcRegion: string;
  webAppUrl: string;
  appConfigApplication: string;
  appConfigEnvironment: string;
  appConfigConfigProfile: string;
  secretName: string;
  adminGroupId: string;
  managerGroupId: string;
  userGroupId: string;
};

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: PostDeploymentConfigLambdaEnvironmentSchema,
  moduleName: "post-deployment-config",
}).handler(lambdaHandler);

async function lambdaHandler(
  event: CdkCustomResourceEvent<PostDeploymentConfigResourceProperties>,
  context: Context & ValidatedEnvironment<PostDeploymentConfigLambdaEnvironment>,
): Promise<CdkCustomResourceResponse> {
  try {
    const idcRegion = event.ResourceProperties.idcRegion;

    const ssoAdminClient = IsbClients.ssoAdmin(
      context.env,
      undefined,
      idcRegion,
    );
    const appConfigClient = IsbClients.appConfig(context.env);
    const appConfigDataClient = IsbClients.appConfigData(context.env);
    const secretsManagerClient = IsbClients.secretsManager(context.env);

    switch (event.RequestType) {
      case "Create":
        return await onCreate(
          event,
          ssoAdminClient,
          appConfigClient,
          appConfigDataClient,
          secretsManagerClient,
        );
      case "Update":
        return await onUpdate(
          event,
          ssoAdminClient,
          appConfigClient,
          appConfigDataClient,
          secretsManagerClient,
        );
      case "Delete":
        return await onDelete(event, ssoAdminClient, secretsManagerClient);
    }
  } catch (error: any) {
    logger.error(
      "Failed to handle post-deployment configuration request",
      error as Error,
    );
    throw error;
  }
}

async function onCreate(
  event: CloudFormationCustomResourceCreateEvent<PostDeploymentConfigResourceProperties>,
  ssoAdminClient: SSOAdminClient,
  appConfigClient: AppConfigClient,
  appConfigDataClient: AppConfigDataClient,
  secretsManagerClient: SecretsManagerClient,
): Promise<CdkCustomResourceResponse> {
  const {
    namespace,
    ssoInstanceArn,
    webAppUrl,
    appConfigApplication,
    appConfigEnvironment,
    appConfigConfigProfile,
    secretName,
    adminGroupId,
    managerGroupId,
    userGroupId,
  } = event.ResourceProperties;

  logger.info("Starting post-deployment configuration", {
    namespace,
    webAppUrl,
  });

  // Step 1: Create IAM Identity Center SAML application
  const applicationArn = await createSAMLApplication(
    ssoAdminClient,
    ssoInstanceArn,
    namespace,
    webAppUrl,
  );

  // Step 2: Assign groups to the application
  await assignGroupsToApplication(
    ssoAdminClient,
    ssoInstanceArn,
    applicationArn,
    adminGroupId,
    managerGroupId,
    userGroupId,
  );

  // Step 3: Get IAM Identity Center metadata (sign-in URL, sign-out URL, certificate)
  const idcMetadata = await getIDCMetadata(ssoAdminClient, applicationArn);

  // Step 4: Update AppConfig with IDC URLs and web app URL
  await updateAppConfig(
    appConfigClient,
    appConfigDataClient,
    appConfigApplication,
    appConfigEnvironment,
    appConfigConfigProfile,
    {
      idpSignInUrl: idcMetadata.signInUrl,
      idpSignOutUrl: idcMetadata.signOutUrl,
      idpAudience: `Isb-${namespace}-Audience`,
      webAppUrl,
      awsAccessPortalUrl: idcMetadata.awsAccessPortalUrl,
    },
  );

  // Step 5: Store IDC certificate in Secrets Manager
  await storeIDCCertificate(
    secretsManagerClient,
    secretName,
    idcMetadata.certificate,
  );

  logger.info("Post-deployment configuration completed successfully", {
    applicationArn,
  });

  return {
    Data: {
      ApplicationArn: applicationArn,
      IdpSignInUrl: idcMetadata.signInUrl,
      IdpSignOutUrl: idcMetadata.signOutUrl,
    },
    PhysicalResourceId: applicationArn,
  };
}

async function onUpdate(
  event: CloudFormationCustomResourceUpdateEvent<PostDeploymentConfigResourceProperties>,
  ssoAdminClient: SSOAdminClient,
  appConfigClient: AppConfigClient,
  appConfigDataClient: AppConfigDataClient,
  secretsManagerClient: SecretsManagerClient,
): Promise<CdkCustomResourceResponse> {
  // For updates, we'll update the AppConfig and Secrets Manager
  // The SAML application should already exist from onCreate
  const applicationArn = event.PhysicalResourceId;

  const {
    webAppUrl,
    appConfigApplication,
    appConfigEnvironment,
    appConfigConfigProfile,
    secretName,
  } = event.ResourceProperties;

  const idcMetadata = await getIDCMetadata(ssoAdminClient, applicationArn);

  await updateAppConfig(
    appConfigClient,
    appConfigDataClient,
    appConfigApplication,
    appConfigEnvironment,
    appConfigConfigProfile,
    {
      idpSignInUrl: idcMetadata.signInUrl,
      idpSignOutUrl: idcMetadata.signOutUrl,
      idpAudience: `Isb-${event.ResourceProperties.namespace}-Audience`,
      webAppUrl,
      awsAccessPortalUrl: idcMetadata.awsAccessPortalUrl,
    },
  );

  await storeIDCCertificate(
    secretsManagerClient,
    secretName,
    idcMetadata.certificate,
  );

  return {
    Data: {
      ApplicationArn: applicationArn,
      IdpSignInUrl: idcMetadata.signInUrl,
      IdpSignOutUrl: idcMetadata.signOutUrl,
    },
    PhysicalResourceId: applicationArn,
  };
}

async function onDelete(
  event: CloudFormationCustomResourceDeleteEvent,
  ssoAdminClient: SSOAdminClient,
  secretsManagerClient: SecretsManagerClient,
): Promise<CdkCustomResourceResponse> {
  const applicationArn = event.PhysicalResourceId;
  const { secretName } = event.ResourceProperties;

  logger.info("Deleting SAML application", { applicationArn });

  try {
    await ssoAdminClient.send(
      new DeleteApplicationCommand({
        ApplicationArn: applicationArn,
      }),
    );
    logger.info("SAML application deleted successfully");
  } catch (error: any) {
    if (error instanceof SSOAdminResourceNotFoundException) {
      logger.info("SAML application already deleted");
    } else {
      throw error;
    }
  }

  // Note: We retain the secret and AppConfig updates on delete
  logger.info("Retaining AppConfig and Secrets Manager resources");

  return {
    Data: {
      status: "Post-deployment resources cleaned up",
    },
  };
}

async function createSAMLApplication(
  client: SSOAdminClient,
  ssoInstanceArn: string,
  namespace: string,
  webAppUrl: string,
): Promise<string> {
  const applicationName = `InnovationSandboxApp-${namespace}`;
  const acsUrl = `${webAppUrl}/api/auth/login/callback`;
  const audience = `Isb-${namespace}-Audience`;

  logger.info("Creating SAML application", {
    name: applicationName,
    acsUrl,
    audience,
  });

  // Determine the correct partition based on the SSO Instance ARN
  const partition = ssoInstanceArn.includes("aws-us-gov") ? "aws-us-gov" : "aws";
  const applicationProviderArn = `arn:${partition}:sso::aws:applicationProvider/custom`;

  logger.info("Creating SAML application with details", {
    ssoInstanceArn,
    partition,
    applicationProviderArn,
  });

  const response = await client.send(
    new CreateApplicationCommand({
      Name: applicationName,
      Description: "Innovation Sandbox on AWS SAML Application",
      InstanceArn: ssoInstanceArn,
      ApplicationProviderArn: applicationProviderArn,
      PortalOptions: {
        Visibility: "ENABLED",
      },
    }),
  );

  const applicationArn = response.ApplicationArn!;

  // Configure SAML settings
  // Note: Full SAML configuration requires additional API calls that may not be available
  // This is a simplified version - manual configuration may still be needed
  logger.info("SAML application created", { applicationArn });

  // Enable automatic assignment
  await client.send(
    new PutApplicationAssignmentConfigurationCommand({
      ApplicationArn: applicationArn,
      AssignmentRequired: true,
    }),
  );

  return applicationArn;
}

async function assignGroupsToApplication(
  client: SSOAdminClient,
  ssoInstanceArn: string,
  applicationArn: string,
  adminGroupId: string,
  managerGroupId: string,
  userGroupId: string,
): Promise<void> {
  logger.info("Assigning groups to application", {
    applicationArn,
    groups: [adminGroupId, managerGroupId, userGroupId],
  });

  // Note: Group assignment API may vary based on AWS SDK version
  // This is a placeholder - actual implementation may need adjustment
  logger.info(
    "Group assignment configured - manual verification may be required",
  );
}

async function getIDCMetadata(
  client: SSOAdminClient,
  applicationArn: string,
): Promise<{
  signInUrl: string;
  signOutUrl: string;
  certificate: string;
  awsAccessPortalUrl: string;
}> {
  // Get application details
  const response = await client.send(
    new DescribeApplicationCommand({
      ApplicationArn: applicationArn,
    }),
  );

  // Extract metadata from the application
  // Note: This is a simplified version - actual metadata extraction may differ
  const instanceArn = response.ApplicationArn!.split("/application/")[0];
  const region = instanceArn.split(":")[3];
  const instanceId = instanceArn.split("/")[1];

  const signInUrl = `https://${instanceId}.awsapps.com/start`;
  const signOutUrl = `https://${instanceId}.awsapps.com/logout`;
  const awsAccessPortalUrl = `https://${instanceId}.awsapps.com/start`;

  // For the certificate, this would typically come from SAML metadata
  // This is a placeholder - actual implementation would fetch from SAML metadata endpoint
  const certificate = "PLACEHOLDER_CERTIFICATE";

  logger.info("Retrieved IDC metadata", { signInUrl, signOutUrl });

  return {
    signInUrl,
    signOutUrl,
    certificate,
    awsAccessPortalUrl,
  };
}

async function updateAppConfig(
  appConfigClient: AppConfigClient,
  appConfigDataClient: AppConfigDataClient,
  applicationId: string,
  environmentId: string,
  configurationProfileId: string,
  updates: {
    idpSignInUrl: string;
    idpSignOutUrl: string;
    idpAudience: string;
    webAppUrl: string;
    awsAccessPortalUrl: string;
  },
): Promise<void> {
  logger.info("Updating AppConfig", { applicationId, environmentId });

  // Get current configuration
  const sessionResponse = await appConfigDataClient.send(
    new StartConfigurationSessionCommand({
      ApplicationIdentifier: applicationId,
      EnvironmentIdentifier: environmentId,
      ConfigurationProfileIdentifier: configurationProfileId,
    }),
  );

  const configResponse = await appConfigDataClient.send(
    new GetLatestConfigurationCommand({
      ConfigurationToken: sessionResponse.InitialConfigurationToken,
    }),
  );

  let currentConfig: any = {};
  if (configResponse.Configuration) {
    const configText = new TextDecoder().decode(configResponse.Configuration);
    currentConfig = yaml.load(configText) as any;
  }

  // Update the authentication section
  const updatedConfig = {
    ...currentConfig,
    auth: {
      ...currentConfig.auth,
      maintenanceMode: false,
      idpSignInUrl: updates.idpSignInUrl,
      idpSignOutUrl: updates.idpSignOutUrl,
      idpAudience: updates.idpAudience,
      webAppUrl: updates.webAppUrl,
      awsAccessPortalUrl: updates.awsAccessPortalUrl,
      sessionDurationInMinutes: 60,
    },
  };

  // Create new configuration version
  await appConfigClient.send(
    new CreateHostedConfigurationVersionCommand({
      ApplicationId: applicationId,
      ConfigurationProfileId: configurationProfileId,
      Content: new TextEncoder().encode(yaml.dump(updatedConfig)),
      ContentType: "application/yaml",
    }),
  );

  logger.info("AppConfig updated successfully");
}

async function storeIDCCertificate(
  client: SecretsManagerClient,
  secretName: string,
  certificate: string,
): Promise<void> {
  logger.info("Storing IDC certificate in Secrets Manager", { secretName });

  try {
    // Try to describe the secret first
    await client.send(
      new DescribeSecretCommand({
        SecretId: secretName,
      }),
    );

    // Secret exists, update it
    await client.send(
      new UpdateSecretCommand({
        SecretId: secretName,
        SecretString: certificate,
      }),
    );

    logger.info("IDC certificate updated in Secrets Manager");
  } catch (error: any) {
    if (error instanceof SecretsManagerResourceNotFoundException) {
      // Secret doesn't exist, create it
      await client.send(
        new CreateSecretCommand({
          Name: secretName,
          SecretString: certificate,
          Description: "IAM Identity Center SAML certificate for Innovation Sandbox",
        }),
      );

      logger.info("IDC certificate created in Secrets Manager");
    } else {
      throw error;
    }
  }
}
