#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ensure ECR repository exists, create if it doesn't
 *
 * Usage:
 *   node scripts/ensure-ecr-repo.cjs <repo-name> <region> [profile]
 *
 * Returns: 0 if repo exists or was created, 1 on error
 */

const { execSync } = require('child_process');

const args = process.argv.slice(2);
const repoName = args[0];
const region = args[1] || 'us-east-1';
const profile = args[2];

if (!repoName) {
  console.error('Error: Repository name required');
  console.error('Usage: node scripts/ensure-ecr-repo.cjs <repo-name> <region> [profile]');
  process.exit(1);
}

const profileFlag = profile ? `--profile ${profile}` : '';

try {
  // Check if repository exists
  console.log(`Checking if ECR repository "${repoName}" exists in ${region}...`);

  execSync(
    `aws ecr describe-repositories --repository-names ${repoName} --region ${region} ${profileFlag}`,
    { stdio: 'pipe' }
  );

  console.log(`✓ ECR repository "${repoName}" already exists`);
  process.exit(0);
} catch (error) {
  // Repository doesn't exist, create it
  console.log(`Creating ECR repository "${repoName}" in ${region}...`);

  try {
    execSync(
      `aws ecr create-repository --repository-name ${repoName} --region ${region} --image-scanning-configuration scanOnPush=true ${profileFlag}`,
      { stdio: 'inherit' }
    );

    console.log(`✓ ECR repository "${repoName}" created successfully`);
    process.exit(0);
  } catch (createError) {
    console.error(`❌ Failed to create ECR repository: ${createError.message}`);
    process.exit(1);
  }
}
