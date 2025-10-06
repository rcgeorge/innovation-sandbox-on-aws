#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CostInfoLambdaStack, CreateGovCloudAccountLambdaStack } from '../lib/lambda-stacks';
import { ApiGatewayStack } from '../lib/api-gateway-stack';

const app = new cdk.App();

// Get environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Create Lambda stacks
const costInfoStack = new CostInfoLambdaStack(app, 'CostInfoLambdaStack', { env });
const createGovCloudAccountStack = new CreateGovCloudAccountLambdaStack(app, 'CreateGovCloudAccountLambdaStack', { env });

// Create API Gateway stack (depends on Lambda stacks)
const apiStack = new ApiGatewayStack(app, 'ApiGatewayStack', {
  env,
  costInfoLambda: costInfoStack.lambdaFunction,
  createGovCloudAccountLambda: createGovCloudAccountStack.lambdaFunction,
});

apiStack.addDependency(costInfoStack);
apiStack.addDependency(createGovCloudAccountStack);

app.synth();
