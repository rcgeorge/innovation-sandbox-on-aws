// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface ApiGatewayStackProps extends cdk.StackProps {
  costInfoLambda: lambda.IFunction;
  createGovCloudAccountLambda: lambda.IFunction;
}

export class ApiGatewayStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly apiKey: apigateway.ApiKey;

  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);

    // Create CloudWatch log group for API Gateway
    const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create REST API
    this.api = new apigateway.RestApi(this, 'CommercialBridgeApi', {
      restApiName: 'Commercial Bridge API',
      description: 'API Gateway for GovCloud cost tracking and account creation',
      cloudWatchRole: false, // Disable account-level CloudWatch role requirement
      deployOptions: {
        stageName: 'prod',
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-Api-Key', 'Authorization'],
      },
    });

    // Create API Key
    this.apiKey = new apigateway.ApiKey(this, 'CommercialBridgeApiKey', {
      apiKeyName: 'GovCloudBridgeKey',
      description: 'API key for GovCloud Innovation Sandbox to access commercial bridge API',
      enabled: true,
    });

    // Create Usage Plan
    const usagePlan = new apigateway.UsagePlan(this, 'UsagePlan', {
      name: 'CommercialBridgeUsagePlan',
      description: 'Usage plan for GovCloud access to commercial bridge',
      throttle: {
        rateLimit: 100, // requests per second
        burstLimit: 200, // maximum burst capacity
      },
      quota: {
        limit: 10000, // 10k requests per month
        period: apigateway.Period.MONTH,
      },
    });

    // Associate API stage with usage plan
    usagePlan.addApiStage({
      stage: this.api.deploymentStage,
    });

    // Associate API key with usage plan
    usagePlan.addApiKey(this.apiKey);

    // Create /cost-info resource
    const costInfoResource = this.api.root.addResource('cost-info');
    costInfoResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(props.costInfoLambda, {
        proxy: true,
      }),
      {
        apiKeyRequired: true,
      }
    );

    // Create /govcloud-accounts resource
    const govCloudAccountsResource = this.api.root.addResource('govcloud-accounts');

    // POST method for creating accounts
    govCloudAccountsResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(props.createGovCloudAccountLambda, {
        proxy: true,
      }),
      {
        apiKeyRequired: true,
      }
    );

    // GET method for checking account creation status
    // Pattern: /govcloud-accounts/{requestId}
    const requestIdResource = govCloudAccountsResource.addResource('{requestId}');
    requestIdResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(props.createGovCloudAccountLambda, {
        proxy: true,
      }),
      {
        apiKeyRequired: true,
      }
    );

    // CloudFormation outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway URL',
      exportName: 'CommercialBridgeApiUrl',
    });

    new cdk.CfnOutput(this, 'ApiKeyId', {
      value: this.apiKey.keyId,
      description: 'API Key ID (retrieve value using: aws apigateway get-api-key --api-key <id> --include-value)',
      exportName: 'CommercialBridgeApiKeyId',
    });
  }
}
