// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type {
  APIGatewayRequestAuthorizerEvent,
  AuthResponse,
  PolicyDocument,
  StatementEffect,
} from "aws-lambda";

import {
  extractMethodAndPathFromArn,
  isAuthorized,
} from "@amzn/innovation-sandbox-authorizer/authorization.js";
import {
  AuthorizerLambdaEnvironment,
  AuthorizerLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/authorizer-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { IsbUser } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { decodeJwt } from "@amzn/innovation-sandbox-commons/utils/jwt.js";

const tracer = new Tracer();
const logger = new Logger();

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: AuthorizerLambdaEnvironmentSchema,
  moduleName: "authorizer",
})
  .use(isbConfigMiddleware())
  .handler(lambdaHandler);

async function lambdaHandler(
  event: APIGatewayRequestAuthorizerEvent,
  context: ContextWithConfig &
    ValidatedEnvironment<AuthorizerLambdaEnvironment>,
): Promise<AuthResponse> {
  try {
    // HTTP headers are case-insensitive, but JS objects are case-sensitive
    // Check both Authorization and authorization
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const parts = authHeader?.split(" ");
    if (!parts) {
      logger.info("Authorization header not provided");
      return generatePolicy("user", "Deny", event.methodArn);
    }
    if (parts[0]! !== "Bearer") {
      logger.info(`Invalid Bearer prefix ${parts[0]}`);
      return generatePolicy("user", "Deny", event.methodArn);
    }
    const jwtToken = parts[1]!;
    const decoded = decodeJwt(jwtToken);
    if (!decoded) {
      logger.info("Invalid JWT - rejected authorization", { token: jwtToken });
      return generatePolicy("user", "Deny", event.methodArn);
    }
    const user = decoded as IsbUser;
    if (context.globalConfig.maintenanceMode) {
      if (!isAllowedInMaintenanceMode(event, user)) {
        logger.info(
          "In maintenance mode, rejecting all calls from non Admin users and non GET /configuration calls",
        );
        return generatePolicy("user", "Deny", event.methodArn);
      }
    }
    const authorized = await isAuthorized(
      { methodArn: event.methodArn, authorizationToken: jwtToken },
      {
        logger,
        tracer,
        env: context.env,
      },
    );
    if (authorized) {
      logger.info(`authorized ${user.email} for ${event.methodArn}`);
      return generatePolicy("user", "Allow", event.methodArn);
    } else {
      logger.info(
        `rejected authorization of ${user.email} for ${event.methodArn}`,
      );
      return generatePolicy("user", "Deny", event.methodArn);
    }
  } catch (error) {
    logger.error("Failed to authorize request", error as Error);
    return generatePolicy("user", "Deny", event.methodArn);
  }
}

function isAllowedInMaintenanceMode(
  event: APIGatewayRequestAuthorizerEvent,
  user: IsbUser,
): boolean {
  const methodAndPath = extractMethodAndPathFromArn(event.methodArn);
  const isGetConfig =
    methodAndPath &&
    methodAndPath.method === "GET" &&
    methodAndPath.path === "/configurations";
  return (user.roles?.includes("Admin") ?? false) || (isGetConfig ?? false);
}

function generatePolicy(
  principalId: string,
  effect: StatementEffect,
  resource: string,
): AuthResponse {
  const authResponse: AuthResponse = {
    principalId: principalId,
    policyDocument: {} as PolicyDocument,
  };

  if (effect && resource) {
    authResponse.policyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    };
  }

  return authResponse;
}
