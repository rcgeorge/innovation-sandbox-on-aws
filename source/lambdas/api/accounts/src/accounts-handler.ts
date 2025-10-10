// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import middy from "@middy/core";
import httpRouterHandler, { Route } from "@middy/http-router";
import {
  APIGatewayProxyEventPathParameters,
  APIGatewayProxyResult,
} from "aws-lambda";
import { SFNClient, StartExecutionCommand, DescribeExecutionCommand } from "@aws-sdk/client-sfn";

import { SandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import {
  AccountInCleanUpError,
  AccountNotInQuarantineError,
  InnovationSandbox,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { createCommercialBridgeClient } from "@amzn/innovation-sandbox-commons/isb-services/commercial-bridge-factory.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { z } from "zod";
import {
  AccountLambdaEnvironment,
  AccountLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import apiMiddlewareBundle, {
  IsbApiContext,
  IsbApiEvent,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { corsMiddleware } from "@amzn/innovation-sandbox-commons/lambda/middleware/cors-middleware.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { httpJsonBodyParser } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-json-body-parser.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { createPaginationQueryStringParametersSchema } from "@amzn/innovation-sandbox-commons/lambda/schemas.js";
import { AppInsightsLogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  fromTemporaryIsbIdcCredentials,
  fromTemporaryIsbOrgManagementCredentials,
} from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

const tracer = new Tracer();
const logger = new Logger();

const middyFactory = middy<IsbApiEvent, any, Error, AccountsApiContext>;

const routes: Route<IsbApiEvent, APIGatewayProxyResult>[] = [
  {
    path: "/accounts",
    method: "GET",
    handler: middyFactory().handler(findAccountsHandler),
  },
  {
    path: "/accounts",
    method: "POST",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(postAccountHandler),
  },
  {
    path: "/accounts/{awsAccountId}",
    method: "GET",
    handler: middyFactory().handler(getAccountHandler),
  },
  {
    path: "/accounts/{awsAccountId}/retryCleanup",
    method: "POST",
    handler: middyFactory().handler(retryCleanupHandler),
  },
  {
    path: "/accounts/{awsAccountId}/eject",
    method: "POST",
    handler: middyFactory().handler(ejectAccountHandler),
  },
  {
    path: "/accounts/unregistered",
    method: "GET",
    handler: middyFactory().handler(findUnregisteredAccountsHandler),
  },
  {
    path: "/accounts/govcloud/create",
    method: "POST",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(createGovCloudAccountHandler),
  },
  {
    path: "/accounts/govcloud/create/status/{executionId}",
    method: "GET",
    handler: middyFactory().handler(getGovCloudAccountStatusHandler),
  },
  {
    path: "/accounts/govcloud/available",
    method: "GET",
    handler: middyFactory().handler(getAvailableGovCloudAccountsHandler),
  },
];

export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: AccountLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .use(corsMiddleware())
  .handler(httpRouterHandler(routes));

type AccountsApiContext = ContextWithConfig &
  IsbApiContext<AccountLambdaEnvironment>;

async function findAccountsHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  const accountStore = IsbServices.sandboxAccountStore(context.env);

  const parsedPaginationParametersResult =
    createPaginationQueryStringParametersSchema({
      maxPageSize: 2000,
    }).safeParse(event.queryStringParameters);

  if (!parsedPaginationParametersResult.success) {
    throw createHttpJSendValidationError(
      parsedPaginationParametersResult.error,
    );
  }

  const { pageIdentifier, pageSize } = parsedPaginationParametersResult.data;

  const queryResult = await accountStore.findAll({ pageIdentifier, pageSize });
  if (queryResult.error) {
    logger.warn(
      `${AppInsightsLogPatterns.DataValidationWarning.pattern}: Error while fetching accounts: ${queryResult.error}`,
    );
  }
  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: queryResult,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function postAccountHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  const accountParseResponse = SandboxAccountSchema.omit({
    cleanupExecutionContext: true,
    status: true,
    driftAtLastScan: true,
  })
    .strict()
    .safeParse(event.body);

  if (!accountParseResponse.success) {
    throw createHttpJSendValidationError(accountParseResponse.error);
  }

  const { ORG_MGT_ACCOUNT_ID, IDC_ACCOUNT_ID, HUB_ACCOUNT_ID } = context.env;
  if (
    [ORG_MGT_ACCOUNT_ID, IDC_ACCOUNT_ID, HUB_ACCOUNT_ID].includes(
      accountParseResponse.data.awsAccountId,
    )
  ) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          {
            message: `Account is an ISB administration account. Aborting registration.`,
          },
        ],
      },
    });
  }

  const isbContext = {
    logger,
    tracer,
    eventBridgeClient: IsbServices.isbEventBridge(context.env),
    orgsService: IsbServices.orgsService(
      context.env,
      fromTemporaryIsbOrgManagementCredentials(context.env),
    ),
    idcService: IsbServices.idcService(
      context.env,
      fromTemporaryIsbIdcCredentials(context.env),
    ),
  };

  const result = await InnovationSandbox.registerAccount(
    accountParseResponse.data.awsAccountId,
    isbContext,
  );

  return {
    statusCode: 201,
    body: JSON.stringify({
      status: "success",
      data: result,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function getAccountHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  const awsAccountId = parseAwsAccountIdFromPathParameters(
    event.pathParameters,
  );
  const accountStore = IsbServices.sandboxAccountStore(context.env);
  const accountResponse = await accountStore.get(awsAccountId);
  const account = accountResponse.result;
  if (accountResponse.error) {
    logger.warn(
      `${AppInsightsLogPatterns.DataValidationWarning.pattern}: Error in retrieving account ${awsAccountId}: ${accountResponse.error}`,
    );
  }
  if (!account) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: `Account not found.`,
          },
        ],
      },
    });
  }
  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: account,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function ejectAccountHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
) {
  const awsAccountId = parseAwsAccountIdFromPathParameters(
    event.pathParameters,
  );

  const accountStore = IsbServices.sandboxAccountStore(context.env);
  const accountResponse = await accountStore.get(awsAccountId);
  const account = accountResponse.result;
  if (accountResponse.error) {
    logger.warn(
      `${AppInsightsLogPatterns.DataValidationWarning.pattern}: Error in retrieving account ${awsAccountId}: ${accountResponse.error}`,
    );
  }

  if (!account) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: `Account not found.`,
          },
        ],
      },
    });
  }

  try {
    await InnovationSandbox.ejectAccount(
      {
        sandboxAccount: account,
      },
      {
        logger,
        tracer,
        sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
        leaseStore: IsbServices.leaseStore(context.env),
        orgsService: IsbServices.orgsService(
          context.env,
          fromTemporaryIsbOrgManagementCredentials(context.env),
        ),
        idcService: IsbServices.idcService(
          context.env,
          fromTemporaryIsbIdcCredentials(context.env),
        ),
        eventBridgeClient: IsbServices.isbEventBridge(context.env),
        globalConfig: context.globalConfig,
      },
    );
  } catch (error) {
    if (error instanceof AccountInCleanUpError) {
      throw createHttpJSendError({
        statusCode: 409,
        data: { errors: [{ message: error.message }] },
      });
    } else {
      throw error;
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function retryCleanupHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  const awsAccountId = parseAwsAccountIdFromPathParameters(
    event.pathParameters,
  );

  const accountStore = IsbServices.sandboxAccountStore(context.env);
  const accountResponse = await accountStore.get(awsAccountId);
  const account = accountResponse.result;
  if (accountResponse.error) {
    logger.warn(
      `${AppInsightsLogPatterns.DataValidationWarning.pattern}: Error retrieving account ${awsAccountId}: ${accountResponse.error}`,
    );
  }

  if (!account) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: `Account not found.`,
          },
        ],
      },
    });
  }

  try {
    await InnovationSandbox.retryCleanup(
      {
        sandboxAccount: account,
      },
      {
        logger,
        tracer,
        eventBridgeClient: IsbServices.isbEventBridge(context.env),
        orgsService: IsbServices.orgsService(
          context.env,
          fromTemporaryIsbOrgManagementCredentials(context.env),
        ),
        sandboxAccountStore: accountStore,
      },
    );
  } catch (error) {
    if (error instanceof AccountNotInQuarantineError) {
      throw createHttpJSendError({
        statusCode: 409,
        data: { errors: [{ message: error.message }] },
      });
    } else {
      throw error;
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function findUnregisteredAccountsHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  const parsedPaginationParametersResult =
    createPaginationQueryStringParametersSchema({ maxPageSize: 20 }).safeParse(
      event.queryStringParameters,
    );

  if (!parsedPaginationParametersResult.success) {
    throw createHttpJSendValidationError(
      parsedPaginationParametersResult.error,
    );
  }

  const { pageIdentifier, pageSize } = parsedPaginationParametersResult.data;

  const orgService = IsbServices.orgsService(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );

  const unregisteredAccounts = await orgService.listAccountsInOU({
    ouName: "Entry",
    pageIdentifier,
    pageSize,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        result:
          unregisteredAccounts.accounts?.map((account) => ({
            Id: account.Id,
            Email: account.Email,
            Name: account.Name,
          })) ?? [],
        nextPageIdentifier: unregisteredAccounts.nextPageIdentifier,
      },
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

function parseAwsAccountIdFromPathParameters(
  pathParameters: APIGatewayProxyEventPathParameters,
) {
  const PathParametersSchema = SandboxAccountSchema.pick({
    awsAccountId: true,
  });
  const parsedPathParametersResponse =
    PathParametersSchema.safeParse(pathParameters);
  if (!parsedPathParametersResponse.success) {
    throw createHttpJSendValidationError(parsedPathParametersResponse.error);
  }
  return parsedPathParametersResponse.data.awsAccountId;
}

const CreateGovCloudAccountRequestSchema = z.discriminatedUnion("mode", [
  // Create new account mode
  z.object({
    mode: z.literal("create"),
    accountName: z.string().min(1).max(50),
    email: z.string().email(),
  }),
  // Join existing account mode
  z.object({
    mode: z.literal("join-existing"),
    govCloudAccountId: z.string().regex(/^\d{12}$/),
    commercialAccountId: z.string().regex(/^\d{12}$/),
    accountName: z.string().min(1).max(50),
  }),
]);

async function createGovCloudAccountHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  // Parse and validate request
  const bodyParseResult = CreateGovCloudAccountRequestSchema.safeParse(event.body);
  if (!bodyParseResult.success) {
    throw createHttpJSendValidationError(bodyParseResult.error);
  }

  const requestData = bodyParseResult.data;

  // Check if Step Function is configured
  if (!context.env.GOVCLOUD_CREATION_STEP_FUNCTION_ARN) {
    throw createHttpJSendError({
      statusCode: 501,
      data: {
        errors: [{
          message: "GovCloud account creation not configured. Step Function ARN is missing."
        }]
      }
    });
  }

  logger.info("Starting GovCloud account workflow", { mode: requestData.mode });

  // Start Step Function execution with mode-specific input
  const sfnClient = new SFNClient({});

  try {
    const execution = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: context.env.GOVCLOUD_CREATION_STEP_FUNCTION_ARN,
      input: JSON.stringify(requestData),
    }));

    // Extract execution ID from ARN
    const executionArn = execution.executionArn!;
    const executionId = executionArn.split(':').pop()!;

    logger.info("Step Function execution started", {
      executionArn,
      executionId,
      mode: requestData.mode,
    });

    const message = requestData.mode === "create"
      ? "GovCloud account creation started. This will take 5-10 minutes."
      : "GovCloud account join workflow started. This will take 3-5 minutes.";

    return {
      statusCode: 202,
      body: JSON.stringify({
        status: "success",
        data: {
          executionId,
          executionArn,
          message,
          mode: requestData.mode,
        }
      }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  } catch (error) {
    logger.error("Failed to start Step Function execution", {
      error: error instanceof Error ? error.message : String(error)
    });

    throw createHttpJSendError({
      statusCode: 500,
      data: {
        errors: [{
          message: `Failed to start workflow: ${error instanceof Error ? error.message : String(error)}`
        }]
      }
    });
  }
}

async function getGovCloudAccountStatusHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  const executionId = event.pathParameters?.executionId;

  if (!executionId) {
    throw createHttpJSendValidationError(
      z.object({ executionId: z.string() }).safeParse({}).error!
    );
  }

  if (!context.env.GOVCLOUD_CREATION_STEP_FUNCTION_ARN) {
    throw createHttpJSendError({
      statusCode: 501,
      data: {
        errors: [{
          message: "GovCloud account creation not configured."
        }]
      }
    });
  }

  // Reconstruct execution ARN from executionId
  const executionArn = `${context.env.GOVCLOUD_CREATION_STEP_FUNCTION_ARN.replace(':stateMachine:', ':execution:')}:${executionId}`;

  const sfnClient = new SFNClient({});

  try {
    const execution = await sfnClient.send(new DescribeExecutionCommand({
      executionArn,
    }));

    const status = execution.status;
    let result: any = null;

    if (status === "SUCCEEDED" && execution.output) {
      result = JSON.parse(execution.output);
    }

    logger.info("Fetched Step Function execution status", { executionId, status });

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        data: {
          executionId,
          status,
          result,
          startDate: execution.startDate,
          stopDate: execution.stopDate,
        }
      }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  } catch (error) {
    logger.error("Failed to fetch execution status", {
      executionId,
      error: error instanceof Error ? error.message : String(error)
    });

    throw createHttpJSendError({
      statusCode: 500,
      data: {
        errors: [{
          message: `Failed to fetch status: ${error instanceof Error ? error.message : String(error)}`
        }]
      }
    });
  }
}

async function getAvailableGovCloudAccountsHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  // Check if commercial bridge is configured (needs URL and either API key or Roles Anywhere)
  const hasApiKey = !!context.env.COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN;
  const hasRolesAnywhere = !!(
    context.env.COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN &&
    context.env.COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN &&
    context.env.COMMERCIAL_BRIDGE_PROFILE_ARN &&
    context.env.COMMERCIAL_BRIDGE_ROLE_ARN
  );

  if (!context.env.COMMERCIAL_BRIDGE_API_URL || (!hasApiKey && !hasRolesAnywhere)) {
    throw createHttpJSendError({
      statusCode: 501,
      data: {
        errors: [{
          message: "GovCloud account listing not configured. Commercial bridge API settings are missing."
        }]
      }
    });
  }

  logger.info("Fetching available GovCloud accounts");

  try {
    // Get all GovCloud accounts from commercial bridge
    const commercialBridge = createCommercialBridgeClient(context.env);

    const { accounts } = await commercialBridge.listGovCloudAccounts();

    // Get existing accounts from DynamoDB to filter them out
    const accountStore = IsbServices.sandboxAccountStore(context.env);

    // Fetch all accounts using pagination
    let allExistingAccounts: any[] = [];
    let pageIdentifier: string | undefined = undefined;
    do {
      const result = await accountStore.findAll({ pageIdentifier, pageSize: 100 });
      allExistingAccounts = [...allExistingAccounts, ...result.result];
      pageIdentifier = result.nextPageIdentifier || undefined;
    } while (pageIdentifier);

    const existingGovCloudIds = new Set(
      allExistingAccounts.map(account => account.awsAccountId)
    );
    const existingCommercialIds = new Set(
      allExistingAccounts
        .filter(account => account.commercialLinkedAccountId)
        .map(account => account.commercialLinkedAccountId)
    );

    // Filter out accounts already in the sandbox
    const availableAccounts = accounts.filter(
      account =>
        !existingGovCloudIds.has(account.govCloudAccountId) &&
        !existingCommercialIds.has(account.commercialAccountId)
    );

    logger.info("Available GovCloud accounts retrieved", {
      total: accounts.length,
      available: availableAccounts.length,
      filtered: accounts.length - availableAccounts.length,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        data: availableAccounts,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  } catch (error) {
    logger.error("Failed to fetch available GovCloud accounts", {
      error: error instanceof Error ? error.message : String(error)
    });

    throw createHttpJSendError({
      statusCode: 500,
      data: {
        errors: [{
          message: `Failed to fetch available accounts: ${error instanceof Error ? error.message : String(error)}`
        }]
      }
    });
  }
}
