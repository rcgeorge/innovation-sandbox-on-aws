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
  AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from "@aws-sdk/client-appconfigdata";
import {
  AppConfigClient,
  CreateHostedConfigurationVersionCommand,
} from "@aws-sdk/client-appconfig";
import {
  SSOAdminClient,
  ListApplicationsCommand,
  DescribeApplicationCommand,
  UpdateApplicationCommand,
  type ApplicationType,
} from "@aws-sdk/client-sso-admin";
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
  webAppUrl: string;
  appConfigApplication: string;
  appConfigEnvironment: string;
  appConfigConfigProfile: string;
  awsAccessPortalUrl: string;
  notificationEmailFrom: string;
  ssoInstanceArn: string;
  identityStoreId: string;
  idcAccountId: string;
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
    const appConfigClient = IsbClients.appConfig(context.env);
    const appConfigDataClient = IsbClients.appConfigData(context.env);

    switch (event.RequestType) {
      case "Create":
        return await onCreate(
          event,
          appConfigClient,
          appConfigDataClient,
        );
      case "Update":
        return await onUpdate(
          event,
          appConfigClient,
          appConfigDataClient,
        );
      case "Delete":
        return await onDelete(event);
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
  appConfigClient: AppConfigClient,
  appConfigDataClient: AppConfigDataClient,
): Promise<CdkCustomResourceResponse> {
  const {
    namespace,
    webAppUrl,
    appConfigApplication,
    appConfigEnvironment,
    appConfigConfigProfile,
    awsAccessPortalUrl,
    notificationEmailFrom,
    ssoInstanceArn,
    identityStoreId,
  } = event.ResourceProperties;

  logger.info("Starting post-deployment AppConfig configuration", {
    namespace,
    webAppUrl,
  });

  // Find and update the IAM Identity Center SAML application
  const ssoAdminClient = new SSOAdminClient({});
  let idpSignInUrl = "";
  let idpSignOutUrl = "";
  let applicationUpdateStatus = "Application not found";

  try {
    const applicationArn = await findIsbApplication(
      ssoAdminClient,
      ssoInstanceArn,
      namespace,
    );

    if (applicationArn) {
      // Update the application's start URL
      await updateApplicationUrl(ssoAdminClient, applicationArn, webAppUrl);
      applicationUpdateStatus = "Application URL updated successfully";

      // Generate SAML URLs based on identity store ID (GovCloud format)
      idpSignInUrl = `https://${identityStoreId}.signin.aws-us-gov/platform/saml/${extractApplicationId(applicationArn)}`;
      idpSignOutUrl = `https://${identityStoreId}.signin.aws-us-gov/platform/logout`;

      logger.info("IAM Identity Center application configured", {
        applicationArn,
        idpSignInUrl,
        idpSignOutUrl,
      });
    } else {
      logger.warn(
        "IAM Identity Center application not found - using placeholder values",
      );
      idpSignInUrl = "MANUAL_SETUP_REQUIRED";
      idpSignOutUrl = "MANUAL_SETUP_REQUIRED";
    }
  } catch (error: any) {
    logger.error("Failed to configure IAM Identity Center application", error);
    idpSignInUrl = "MANUAL_SETUP_REQUIRED";
    idpSignOutUrl = "MANUAL_SETUP_REQUIRED";
    applicationUpdateStatus = `Application update failed: ${error.message}`;
  }

  // Update AppConfig with all configuration values
  await updateAppConfig(
    appConfigClient,
    appConfigDataClient,
    appConfigApplication,
    appConfigEnvironment,
    appConfigConfigProfile,
    {
      idpSignInUrl,
      idpSignOutUrl,
      idpAudience: `Isb-${namespace}-Audience`,
      webAppUrl,
      awsAccessPortalUrl,
      notificationEmailFrom,
    },
  );

  logger.info("Post-deployment configuration completed successfully");

  return {
    Data: {
      Status: applicationUpdateStatus,
      WebAppUrl: webAppUrl,
      AwsAccessPortalUrl: awsAccessPortalUrl,
      IdpSignInUrl: idpSignInUrl,
      IdpSignOutUrl: idpSignOutUrl,
      NotificationEmailFrom: notificationEmailFrom,
    },
    PhysicalResourceId: `PostDeploymentConfig-${namespace}-${Date.now()}`,
  };
}

async function onUpdate(
  event: CloudFormationCustomResourceUpdateEvent<PostDeploymentConfigResourceProperties>,
  appConfigClient: AppConfigClient,
  appConfigDataClient: AppConfigDataClient,
): Promise<CdkCustomResourceResponse> {
  const {
    namespace,
    webAppUrl,
    appConfigApplication,
    appConfigEnvironment,
    appConfigConfigProfile,
    awsAccessPortalUrl,
    notificationEmailFrom,
    ssoInstanceArn,
    identityStoreId,
  } = event.ResourceProperties;

  logger.info("Updating AppConfig configuration", {
    namespace,
    webAppUrl,
  });

  // Find and update the IAM Identity Center SAML application
  const ssoAdminClient = new SSOAdminClient({});
  let idpSignInUrl = "";
  let idpSignOutUrl = "";
  let applicationUpdateStatus = "Application not found";

  try {
    const applicationArn = await findIsbApplication(
      ssoAdminClient,
      ssoInstanceArn,
      namespace,
    );

    if (applicationArn) {
      // Update the application's start URL
      await updateApplicationUrl(ssoAdminClient, applicationArn, webAppUrl);
      applicationUpdateStatus = "Application URL updated successfully";

      // Generate SAML URLs based on identity store ID (GovCloud format)
      idpSignInUrl = `https://${identityStoreId}.signin.aws-us-gov/platform/saml/${extractApplicationId(applicationArn)}`;
      idpSignOutUrl = `https://${identityStoreId}.signin.aws-us-gov/platform/logout`;

      logger.info("IAM Identity Center application configured", {
        applicationArn,
        idpSignInUrl,
        idpSignOutUrl,
      });
    } else {
      logger.warn(
        "IAM Identity Center application not found - using placeholder values",
      );
      idpSignInUrl = "MANUAL_SETUP_REQUIRED";
      idpSignOutUrl = "MANUAL_SETUP_REQUIRED";
    }
  } catch (error: any) {
    logger.error("Failed to configure IAM Identity Center application", error);
    idpSignInUrl = "MANUAL_SETUP_REQUIRED";
    idpSignOutUrl = "MANUAL_SETUP_REQUIRED";
    applicationUpdateStatus = `Application update failed: ${error.message}`;
  }

  await updateAppConfig(
    appConfigClient,
    appConfigDataClient,
    appConfigApplication,
    appConfigEnvironment,
    appConfigConfigProfile,
    {
      idpSignInUrl,
      idpSignOutUrl,
      idpAudience: `Isb-${namespace}-Audience`,
      webAppUrl,
      awsAccessPortalUrl,
      notificationEmailFrom,
    },
  );

  return {
    Data: {
      Status: applicationUpdateStatus,
      WebAppUrl: webAppUrl,
      AwsAccessPortalUrl: awsAccessPortalUrl,
      IdpSignInUrl: idpSignInUrl,
      IdpSignOutUrl: idpSignOutUrl,
      NotificationEmailFrom: notificationEmailFrom,
    },
    PhysicalResourceId: event.PhysicalResourceId,
  };
}

async function onDelete(
  event: CloudFormationCustomResourceDeleteEvent,
): Promise<CdkCustomResourceResponse> {
  logger.info("Post-deployment configuration cleanup", {
    physicalResourceId: event.PhysicalResourceId,
  });

  // Note: We retain AppConfig updates on delete
  logger.info("Retaining AppConfig resources");

  return {
    Data: {
      Status: "Post-deployment configuration cleaned up",
    },
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
    notificationEmailFrom: string;
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

  // Update the authentication and notification sections
  const updatedConfig = {
    ...currentConfig,
    maintenanceMode: false, // Disable maintenance mode
    auth: {
      ...currentConfig.auth,
      idpSignInUrl: updates.idpSignInUrl,
      idpSignOutUrl: updates.idpSignOutUrl,
      idpAudience: updates.idpAudience,
      webAppUrl: updates.webAppUrl,
      awsAccessPortalUrl: updates.awsAccessPortalUrl,
      sessionDurationInMinutes: currentConfig.auth?.sessionDurationInMinutes || 60,
    },
    notification: {
      ...currentConfig.notification,
      emailFrom: updates.notificationEmailFrom,
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

/**
 * Find the Innovation Sandbox IAM Identity Center application
 */
async function findIsbApplication(
  ssoAdminClient: SSOAdminClient,
  ssoInstanceArn: string,
  namespace: string,
): Promise<string | null> {
  const applicationName = `InnovationSandboxApp-${namespace}`;

  logger.info("Searching for IAM Identity Center application", {
    applicationName,
    ssoInstanceArn,
  });

  try {
    const response = await ssoAdminClient.send(
      new ListApplicationsCommand({
        InstanceArn: ssoInstanceArn,
      }),
    );

    const application = response.Applications?.find(
      (app) => app.Name === applicationName,
    );

    if (application?.ApplicationArn) {
      logger.info("Found IAM Identity Center application", {
        applicationArn: application.ApplicationArn,
      });
      return application.ApplicationArn;
    }

    logger.warn("IAM Identity Center application not found", {
      applicationName,
    });
    return null;
  } catch (error: any) {
    logger.error("Error listing IAM Identity Center applications", error);
    throw error;
  }
}

/**
 * Update the IAM Identity Center application's start URL
 */
async function updateApplicationUrl(
  ssoAdminClient: SSOAdminClient,
  applicationArn: string,
  webAppUrl: string,
): Promise<void> {
  logger.info("Updating IAM Identity Center application URL", {
    applicationArn,
    webAppUrl,
  });

  try {
    // Get current application details
    const describeResponse = await ssoAdminClient.send(
      new DescribeApplicationCommand({
        ApplicationArn: applicationArn,
      }),
    );

    // Update the application with new URL
    await ssoAdminClient.send(
      new UpdateApplicationCommand({
        ApplicationArn: applicationArn,
        Name: describeResponse.Name,
        Description: describeResponse.Description,
        Status: describeResponse.Status,
        PortalOptions: {
          SignInOptions: {
            Origin: "APPLICATION",
            ApplicationUrl: webAppUrl,
          },
          Visibility: "ENABLED",
        },
      }),
    );

    logger.info("IAM Identity Center application URL updated successfully");
  } catch (error: any) {
    logger.error("Error updating IAM Identity Center application", error);
    throw error;
  }
}

/**
 * Extract application ID from application ARN
 * ARN format: arn:aws-us-gov:sso::ACCOUNT:application/INSTANCE_ID/APPLICATION_ID
 */
function extractApplicationId(applicationArn: string): string {
  const parts = applicationArn.split("/");
  return parts[parts.length - 1] || "";
}
