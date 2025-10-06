// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { AuthorizationType, IResource, MockIntegration, PassthroughBehavior } from "aws-cdk-lib/aws-apigateway";

/**
 * Adds an OPTIONS method to an API Gateway resource for CORS preflight requests.
 * The OPTIONS method does not require authorization and returns the appropriate CORS headers.
 */
export function addCorsOptions(resource: IResource): void {
  resource.addMethod("OPTIONS", new MockIntegration({
    integrationResponses: [{
      statusCode: "200",
      responseParameters: {
        "method.response.header.Access-Control-Allow-Headers": "'Authorization,Content-Type'",
        "method.response.header.Access-Control-Allow-Methods": "'GET,POST,PUT,DELETE,OPTIONS'",
        "method.response.header.Access-Control-Allow-Origin": "'*'",
        "method.response.header.Access-Control-Allow-Credentials": "'true'",
      },
    }],
    passthroughBehavior: PassthroughBehavior.NEVER,
    requestTemplates: {
      "application/json": '{"statusCode": 200}',
    },
  }), {
    authorizationType: AuthorizationType.NONE,
    methodResponses: [{
      statusCode: "200",
      responseParameters: {
        "method.response.header.Access-Control-Allow-Headers": true,
        "method.response.header.Access-Control-Allow-Methods": true,
        "method.response.header.Access-Control-Allow-Origin": true,
        "method.response.header.Access-Control-Allow-Credentials": true,
      },
    }],
  });
}
