#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import { CostInfoLambdaStack, CreateGovCloudAccountLambdaStack, AcceptInvitationLambdaStack } from '../lib/lambda-stacks';
import { ApiGatewayStack } from '../lib/api-gateway-stack';
import { RolesAnywhereStack, CaType } from '../lib/roles-anywhere-stack';

const app = new cdk.App();

// Get environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// IAM Roles Anywhere configuration (optional)
const enableRolesAnywhere = process.env.ENABLE_ROLES_ANYWHERE === 'true';
const caType = (process.env.ROLES_ANYWHERE_CA_TYPE as CaType) || 'SELF_SIGNED';
const pcaArn = process.env.ROLES_ANYWHERE_PCA_ARN;
const allowedCN = process.env.ROLES_ANYWHERE_ALLOWED_CN || 'govcloud-commercial-bridge';

// Create Lambda stacks
const costInfoStack = new CostInfoLambdaStack(app, 'CostInfoLambdaStack', { env });
const createGovCloudAccountStack = new CreateGovCloudAccountLambdaStack(app, 'CreateGovCloudAccountLambdaStack', { env });
const acceptInvitationStack = new AcceptInvitationLambdaStack(app, 'AcceptInvitationLambdaStack', { env });

// Create API Gateway stack (depends on Lambda stacks)
const apiStack = new ApiGatewayStack(app, 'ApiGatewayStack', {
  env,
  costInfoLambda: costInfoStack.lambdaFunction,
  createGovCloudAccountLambda: createGovCloudAccountStack.lambdaFunction,
  acceptInvitationLambda: acceptInvitationStack.lambdaFunction,
});

apiStack.addDependency(costInfoStack);
apiStack.addDependency(createGovCloudAccountStack);
apiStack.addDependency(acceptInvitationStack);

// Optionally create IAM Roles Anywhere stack for certificate-based auth
if (enableRolesAnywhere) {
  // Load CA certificate for self-signed mode
  let caCertificatePem: string | undefined;
  if (caType === 'SELF_SIGNED') {
    const caCertPath = path.join(__dirname, '../../certs/ca.pem');
    if (!fs.existsSync(caCertPath)) {
      throw new Error(
        `CA certificate not found at ${caCertPath}. ` +
        'Run "npm run roles-anywhere:generate-ca" to generate it.'
      );
    }
    caCertificatePem = fs.readFileSync(caCertPath, 'utf-8');
  }

  const rolesAnywhereStack = new RolesAnywhereStack(app, 'RolesAnywhereStack', {
    env,
    caType,
    caCertificatePem,
    pcaArn,
    apiGatewayArn: `arn:aws:execute-api:${env.region}:${env.account}:${apiStack.api.restApiId}`,
    allowedCertificateCN: allowedCN,
  });

  rolesAnywhereStack.addDependency(apiStack);
}

app.synth();
