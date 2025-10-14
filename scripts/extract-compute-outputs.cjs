#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract Compute Stack outputs and update .env file
 *
 * Extracts REST_API_URL from Compute stack and updates .env automatically
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('\n==============================================');
console.log('Extract Compute Stack Outputs');
console.log('==============================================\n');

const envPath = path.join(__dirname, '..', '.env');

if (!fs.existsSync(envPath)) {
  console.error('❌ .env file not found.\n');
  process.exit(1);
}

try {
  console.log('📋 Extracting REST API URL from Compute stack...\n');

  const apiUrl = execSync(
    'aws cloudformation describe-stacks --stack-name InnovationSandbox-Compute --query "Stacks[0].Outputs[?OutputKey==\'IsbRestApiUrl\' || contains(OutputKey, \'RestApi\')].OutputValue | [0]" --output text',
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();

  if (!apiUrl || apiUrl === 'None') {
    console.error('❌ REST_API_URL not found in Compute stack outputs.');
    console.error('   Make sure InnovationSandbox-Compute is deployed.\n');
    process.exit(1);
  }

  console.log(`✓ REST API URL: ${apiUrl}\n`);

  // Update .env file
  let envContent = fs.readFileSync(envPath, 'utf-8');

  const regex = /^REST_API_URL=.*/m;
  if (envContent.match(regex)) {
    envContent = envContent.replace(regex, `REST_API_URL="${apiUrl}"`);
    console.log('  ✓ Updated REST_API_URL in .env');
  } else {
    // Add it
    envContent += `\nREST_API_URL="${apiUrl}"\n`;
    console.log('  ✓ Added REST_API_URL to .env');
  }

  fs.writeFileSync(envPath, envContent);

  console.log('\n✅ .env file updated successfully!\n');
  console.log(`REST_API_URL="${apiUrl}"\n`);
  console.log('Next steps:');
  console.log('  Deploy Container stack: npm run deploy:container\n');

} catch (error) {
  console.error(`\n❌ Error: ${error.message}\n`);
  process.exit(1);
}
