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
import { PcaStack } from '../lib/pca-stack';

const app = new cdk.App();

// Get environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// PCA configuration (optional)
const enablePca = process.env.ENABLE_PCA === 'true';
const pcaCommonName = process.env.PCA_CA_COMMON_NAME || 'Commercial Bridge Root CA';
const pcaOrganization = process.env.PCA_CA_ORGANIZATION || 'Innovation Sandbox';
const pcaValidityDays = parseInt(process.env.PCA_CA_VALIDITY_DAYS || '3650');

// IAM Roles Anywhere configuration (optional)
const enableRolesAnywhere = process.env.ENABLE_ROLES_ANYWHERE === 'true';
const caType = (process.env.ROLES_ANYWHERE_CA_TYPE as CaType) || 'SELF_SIGNED';
const allowedCN = process.env.ROLES_ANYWHERE_ALLOWED_CN || 'govcloud-commercial-bridge';

// Create Lambda stacks
const costInfoStack = new CostInfoLambdaStack(app, 'CommercialBridge-CostInfo', { env });
const createGovCloudAccountStack = new CreateGovCloudAccountLambdaStack(app, 'CommercialBridge-AccountCreation', { env });
const acceptInvitationStack = new AcceptInvitationLambdaStack(app, 'CommercialBridge-AcceptInvitation', { env });

// Create API Gateway stack (depends on Lambda stacks)
const apiStack = new ApiGatewayStack(app, 'CommercialBridge-ApiGateway', {
  env,
  costInfoLambda: costInfoStack.lambdaFunction,
  createGovCloudAccountLambda: createGovCloudAccountStack.lambdaFunction,
  acceptInvitationLambda: acceptInvitationStack.lambdaFunction,
});

apiStack.addDependency(costInfoStack);
apiStack.addDependency(createGovCloudAccountStack);
apiStack.addDependency(acceptInvitationStack);

// Optionally create PCA for certificate management
let pcaStack: PcaStack | undefined;
if (enablePca) {
  pcaStack = new PcaStack(app, 'CommercialBridge-PCA', {
    env,
    caCommonName: pcaCommonName,
    caOrganization: pcaOrganization,
    caValidityDays: pcaValidityDays,
    enableCrl: true,
  });

  console.log('⚠️  PCA Stack enabled - This will incur ~$400/month costs');
  console.log('   After deployment, run: npm run commercial:pca:issue-client-cert');
}

// Optionally create IAM Roles Anywhere stack for certificate-based auth
if (enableRolesAnywhere) {
  // Determine PCA ARN based on whether PCA stack is deployed
  let pcaArn: string | undefined;
  let caCertificatePem: string | undefined;

  if (caType === 'PCA') {
    if (pcaStack) {
      // Use PCA from our PCA stack
      pcaArn = pcaStack.ca.attrArn;
    } else if (process.env.ROLES_ANYWHERE_PCA_ARN) {
      // Use externally provided PCA ARN
      pcaArn = process.env.ROLES_ANYWHERE_PCA_ARN;
    } else {
      throw new Error(
        'ROLES_ANYWHERE_CA_TYPE is PCA but no PCA found. ' +
          'Either set ENABLE_PCA=true or provide ROLES_ANYWHERE_PCA_ARN',
      );
    }
  } else {
    // Self-signed mode - load CA certificate from file
    const caCertPath = path.join(__dirname, '../../certs/ca.pem');
    if (!fs.existsSync(caCertPath)) {
      throw new Error(
        `CA certificate not found at ${caCertPath}. ` +
          'Run "npm run roles-anywhere:generate-ca" to generate it.',
      );
    }
    caCertificatePem = fs.readFileSync(caCertPath, 'utf-8');
  }

  const rolesAnywhereStack = new RolesAnywhereStack(app, 'CommercialBridge-RolesAnywhere', {
    env,
    caType,
    caCertificatePem,
    pcaArn,
    apiGatewayArn: `arn:aws:execute-api:${env.region}:${env.account}:${apiStack.api.restApiId}`,
    allowedCertificateCN: allowedCN,
  });

  rolesAnywhereStack.addDependency(apiStack);

  if (pcaStack) {
    rolesAnywhereStack.addDependency(pcaStack);
  }
}

app.synth();
