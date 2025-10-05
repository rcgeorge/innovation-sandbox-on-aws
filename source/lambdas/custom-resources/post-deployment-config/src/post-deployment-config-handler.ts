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
// SSO Admin imports removed - SAML application creation not supported via API
// SAML 2.0 applications must be created manually through AWS Console
import {
  AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from "@aws-sdk/client-appconfigdata";
import {
  AppConfigClient,
  CreateHostedConfigurationVersionCommand,
} from "@aws-sdk/client-appconfig";
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
  } = event.ResourceProperties;

  logger.info("Starting post-deployment AppConfig configuration", {
    namespace,
    webAppUrl,
  });

  // Update AppConfig with web app URL and placeholder values for manual SAML setup
  await updateAppConfig(
    appConfigClient,
    appConfigDataClient,
    appConfigApplication,
    appConfigEnvironment,
    appConfigConfigProfile,
    {
      idpSignInUrl: "MANUAL_SETUP_REQUIRED",
      idpSignOutUrl: "MANUAL_SETUP_REQUIRED",
      idpAudience: `Isb-${namespace}-Audience`,
      webAppUrl,
      awsAccessPortalUrl,
    },
  );

  logger.info("Post-deployment configuration completed successfully");

  return {
    Data: {
      Status: "AppConfig updated - SAML application must be created manually",
      WebAppUrl: webAppUrl,
      AwsAccessPortalUrl: awsAccessPortalUrl,
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
  } = event.ResourceProperties;

  logger.info("Updating AppConfig configuration", {
    namespace,
    webAppUrl,
  });

  await updateAppConfig(
    appConfigClient,
    appConfigDataClient,
    appConfigApplication,
    appConfigEnvironment,
    appConfigConfigProfile,
    {
      idpSignInUrl: "MANUAL_SETUP_REQUIRED",
      idpSignOutUrl: "MANUAL_SETUP_REQUIRED",
      idpAudience: `Isb-${namespace}-Audience`,
      webAppUrl,
      awsAccessPortalUrl,
    },
  );

  return {
    Data: {
      Status: "AppConfig updated - SAML application must be created manually",
      WebAppUrl: webAppUrl,
      AwsAccessPortalUrl: awsAccessPortalUrl,
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
