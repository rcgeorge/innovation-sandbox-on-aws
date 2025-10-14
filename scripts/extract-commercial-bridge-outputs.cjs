#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract Commercial Bridge CloudFormation outputs and update .env file
 *
 * This script:
 * 1. Queries Commercial Bridge stack outputs
 * 2. Extracts API URL, ARNs, etc.
 * 3. Updates .env file automatically
 *
 * Usage:
 *   npm run commercial:extract-outputs
 *   node scripts/extract-commercial-bridge-outputs.cjs [--profile commercial]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load .env to get GovCloud configuration
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

// Parse --profile argument
const args = process.argv.slice(2);
const profileArg = args.find(arg => arg.startsWith('--profile'));
let profile = 'commercial'; // Default

if (profileArg) {
  if (profileArg.includes('=')) {
    profile = profileArg.split('=')[1];
  } else {
    const profileIndex = args.indexOf(profileArg);
    if (args[profileIndex + 1]) {
      profile = args[profileIndex + 1];
    }
  }
}

console.log('\n==============================================');
console.log('Extract Commercial Bridge Outputs');
console.log('==============================================\n');
console.log(`Using AWS profile: ${profile}\n`);

if (!fs.existsSync(envPath)) {
  console.error('❌ .env file not found. Run "npm run configure" first.\n');
  process.exit(1);
}

// Helper function to get stack outputs
function getStackOutput(stackName, outputKey) {
  try {
    const command = `aws cloudformation describe-stacks --stack-name ${stackName} --query "Stacks[0].Outputs[?OutputKey=='${outputKey}'].OutputValue" --output text --profile ${profile}`;
    const output = execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return output || null;
  } catch (error) {
    return null;
  }
}

// Extract outputs from each stack
console.log('📋 Extracting outputs from Commercial Bridge stacks...\n');

const outputs = {};

// API Gateway stack
console.log('Checking CommercialBridge-ApiGateway...');
const apiUrl = getStackOutput('CommercialBridge-ApiGateway', 'ApiUrl');
if (apiUrl) {
  outputs.COMMERCIAL_BRIDGE_API_URL = apiUrl;
  console.log(`  ✓ API URL: ${apiUrl}`);
} else {
  console.log('  ⚠️  API URL not found (stack may not be deployed)');
}

// Roles Anywhere stack (optional)
console.log('\nChecking CommercialBridge-RolesAnywhere...');
const trustAnchorArn = getStackOutput('CommercialBridge-RolesAnywhere', 'TrustAnchorArn');
const profileArn = getStackOutput('CommercialBridge-RolesAnywhere', 'ProfileArn');
const roleArn = getStackOutput('CommercialBridge-RolesAnywhere', 'RoleArn');

if (trustAnchorArn || profileArn || roleArn) {
  if (trustAnchorArn) {
    outputs.COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN = trustAnchorArn;
    console.log(`  ✓ Trust Anchor ARN: ${trustAnchorArn}`);
  }
  if (profileArn) {
    outputs.COMMERCIAL_BRIDGE_PROFILE_ARN = profileArn;
    console.log(`  ✓ Profile ARN: ${profileArn}`);
  }
  if (roleArn) {
    outputs.COMMERCIAL_BRIDGE_ROLE_ARN = roleArn;
    console.log(`  ✓ Role ARN: ${roleArn}`);
  }
} else {
  console.log('  ⚠️  Roles Anywhere stack not found (optional stack not deployed)');
}

// PCA stack (optional)
console.log('\nChecking CommercialBridge-PCA...');
const pcaArn = getStackOutput('CommercialBridge-PCA', 'PcaArn');
if (pcaArn) {
  outputs.COMMERCIAL_BRIDGE_PCA_ARN = pcaArn;
  console.log(`  ✓ PCA ARN: ${pcaArn}`);
} else {
  console.log('  ⚠️  PCA stack not found (optional stack not deployed)');
}

// Client Certificate Secret in GovCloud (optional - only if using Roles Anywhere with PCA)
console.log('\nChecking GovCloud Secrets Manager for client certificate...');
const govcloudRegion = process.env.GOVCLOUD_REGION || 'us-gov-east-1';
const govcloudProfile = process.env.AWS_GOVCLOUD_PROFILE || 'default';
const secretName = process.env.GOVCLOUD_SECRET_NAME || '/InnovationSandbox/CommercialBridge/ClientCert';

try {
  // Use JSON output and parse to avoid escaping issues
  const secretInfo = execSync(
    `aws secretsmanager describe-secret --secret-id "${secretName}" --region ${govcloudRegion} --profile ${govcloudProfile} --output json`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();

  if (secretInfo) {
    const secret = JSON.parse(secretInfo);
    if (secret.ARN) {
      outputs.COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN = secret.ARN;
      console.log(`  ✓ Client Cert Secret ARN: ${secret.ARN}`);
    }
  } else {
    console.log('  ⚠️  Client certificate secret not found (run: npm run commercial:pca:issue-and-update-secret)');
  }
} catch (error) {
  console.log('  ⚠️  Client certificate secret not found or not accessible');
  console.log(`     (Secret: ${secretName}, Region: ${govcloudRegion})`);
}

// Check if we found any outputs
if (Object.keys(outputs).length === 0) {
  console.error('\n❌ No Commercial Bridge outputs found. Deploy the stacks first:\n');
  console.error('  npm run commercial:deploy\n');
  process.exit(1);
}

// Update .env file
console.log('\n📝 Updating .env file...\n');

let envContent = fs.readFileSync(envPath, 'utf-8');
let updated = false;

for (const [key, value] of Object.entries(outputs)) {
  const regex = new RegExp(`^(# )?${key}=.*`, 'm');

  if (envContent.match(regex)) {
    // Variable exists (commented or uncommented) - update it
    envContent = envContent.replace(regex, `${key}="${value}"`);
    console.log(`  ✓ Updated ${key}`);
    updated = true;
  } else {
    // Variable doesn't exist - add it to Commercial Bridge section
    const commercialBridgeSection = envContent.indexOf('# Commercial Bridge Configuration');
    if (commercialBridgeSection !== -1) {
      // Find the end of the Commercial Bridge section (next major section or end of file)
      const insertPosition = envContent.indexOf('\n# E2E Test Configs', commercialBridgeSection);
      if (insertPosition !== -1) {
        envContent = envContent.slice(0, insertPosition) +
                    `${key}="${value}"\n` +
                    envContent.slice(insertPosition);
        console.log(`  ✓ Added ${key}`);
        updated = true;
      }
    }
  }
}

if (updated) {
  fs.writeFileSync(envPath, envContent);
  console.log('\n✅ .env file updated successfully!\n');

  console.log('Updated variables:');
  for (const [key, value] of Object.entries(outputs)) {
    console.log(`  ${key}="${value}"`);
  }
  console.log('');
} else {
  console.log('\n⚠️  No updates made to .env file\n');
}

console.log('Next steps:');
console.log('  1. Review your updated .env file');
console.log('  2. Deploy GovCloud stacks: npm run deploy:account-pool, deploy:idc, etc.\n');
