// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { MiddlewareObj } from "@middy/core";
import { APIGatewayProxyResult } from "aws-lambda";
import { ContextWithConfig } from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";

export function corsMiddleware(): MiddlewareObj<
  unknown,
  APIGatewayProxyResult,
  Error,
  ContextWithConfig
> {
  const corsMiddlewareAfter = async (request: any) => {
    const { globalConfig } = request.context as ContextWithConfig;
    const webAppUrl = globalConfig.auth.webAppUrl;

    // Add CORS headers to the response
    if (request.response) {
      request.response.headers = {
        ...request.response.headers,
        "Access-Control-Allow-Origin": webAppUrl,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      };
    }
  };

  return {
    after: corsMiddlewareAfter,
  };
}
