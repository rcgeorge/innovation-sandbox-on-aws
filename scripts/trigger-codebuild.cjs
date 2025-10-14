#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helper script to trigger CodeBuild projects for container image builds
 *
 * Usage:
 *   node scripts/trigger-codebuild.cjs nuke           # Build AWS Nuke container
 *   node scripts/trigger-codebuild.cjs frontend       # Build frontend container
 *   node scripts/trigger-codebuild.cjs all            # Build both containers
 *
 * This script:
 * 1. Retrieves CodeBuild project names from CloudFormation stack outputs
 * 2. Starts CodeBuild builds for the specified projects
 * 3. Provides console URLs for monitoring build progress
 */

const {
  CodeBuildClient,
  StartBuildCommand,
  BatchGetBuildsCommand,
} = require("@aws-sdk/client-codebuild");
const {
  CloudFormationClient,
  DescribeStacksCommand,
} = require("@aws-sdk/client-cloudformation");
const {
  ECRClient,
  DescribeRepositoriesCommand,
  CreateRepositoryCommand,
} = require("@aws-sdk/client-ecr");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// Load .env file
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

// Configuration for different project types
const PROJECT_CONFIG = {
  nuke: {
    stackName: "InnovationSandbox-CodeBuild",
    outputKey: "NukeCodeBuildProjectName",
    description: "AWS Nuke container",
    ecrRepoEnvVar: "PRIVATE_ECR_REPO",
  },
  frontend: {
    stackName: "InnovationSandbox-CodeBuild",
    outputKey: "FrontendCodeBuildProjectName",
    description: "Frontend container",
    ecrRepoEnvVar: "PRIVATE_ECR_FRONTEND_REPO",
  },
};

/**
 * Ensure ECR repository exists, create if it doesn't
 */
async function ensureEcrRepository(repoName, region) {
  if (!repoName) {
    console.log('⚠️  No ECR repository name configured - skipping ECR creation');
    return;
  }

  console.log(`\nChecking if ECR repository "${repoName}" exists in ${region}...`);

  const ecr = new ECRClient({ region });

  try {
    // Check if repository exists
    await ecr.send(
      new DescribeRepositoriesCommand({
        repositoryNames: [repoName],
      })
    );

    console.log(`✓ ECR repository "${repoName}" already exists`);
  } catch (error) {
    if (error.name === 'RepositoryNotFoundException') {
      // Repository doesn't exist, create it
      console.log(`Creating ECR repository "${repoName}" in ${region}...`);

      try {
        await ecr.send(
          new CreateRepositoryCommand({
            repositoryName: repoName,
            imageScanningConfiguration: {
              scanOnPush: true,
            },
          })
        );

        console.log(`✓ ECR repository "${repoName}" created successfully`);
      } catch (createError) {
        console.error(`❌ Failed to create ECR repository: ${createError.message}`);
        throw createError;
      }
    } else {
      throw error;
    }
  }
}

/**
 * Get CloudFormation stack output value
 */
async function getStackOutput(stackName, outputKey) {
  const cfn = new CloudFormationClient({});

  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName })
    );

    if (!response.Stacks || response.Stacks.length === 0) {
      throw new Error(`Stack ${stackName} not found`);
    }

    const stack = response.Stacks[0];
    const output = stack.Outputs?.find((o) => o.OutputKey === outputKey);

    if (!output || !output.OutputValue) {
      throw new Error(`Output ${outputKey} not found in stack ${stackName}`);
    }

    return output.OutputValue;
  } catch (error) {
    if (error.name === "ValidationError") {
      throw new Error(
        `Stack ${stackName} does not exist. Please deploy the CodeBuild stack first:\n` +
          `  npm run deploy:codebuild`
      );
    }
    throw error;
  }
}

/**
 * Upload source code to S3 for CodeBuild
 */
async function uploadSourceToS3(projectType) {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const archiver = require('archiver');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  console.log(`\n📦 Preparing source code for ${projectType}...`);

  // Create zip of repository
  const repoRoot = path.join(__dirname, '..');
  const tempDir = os.tmpdir();
  const zipPath = path.join(tempDir, `innovation-sandbox-source-${Date.now()}.zip`);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', async () => {
      console.log(`✓ Created source archive (${(archive.pointer() / 1024 / 1024).toFixed(2)} MB)`);

      try {
        // Get account and region from environment
        const account = process.env.CDK_DEFAULT_ACCOUNT || process.env.HUB_ACCOUNT_ID;
        const region = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || process.env.PRIVATE_ECR_REPO_REGION || 'us-gov-east-1';

        if (!account || !region) {
          throw new Error(`Cannot determine AWS account (${account}) or region (${region}) from environment`);
        }

        // Upload to S3 (CDK bootstrap bucket)
        const bucketName = `cdk-hnb659fds-assets-${account}-${region}`;
        const key = `codebuild-source/${path.basename(zipPath)}`;

        console.log(`📤 Uploading to s3://${bucketName}/${key}...`);

        const s3 = new S3Client({ region });
        await s3.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: fs.readFileSync(zipPath),
        }));

        console.log('✓ Source uploaded successfully');

        // Cleanup
        fs.unlinkSync(zipPath);

        // Return S3 location in format: bucketname/key
        resolve(`${bucketName}/${key}`);
      } catch (error) {
        fs.unlinkSync(zipPath);
        reject(error);
      }
    });

    archive.on('error', reject);
    archive.pipe(output);

    // Add all source files except node_modules, .git, etc.
    archive.glob('**/*', {
      cwd: repoRoot,
      ignore: [
        'node_modules/**',
        '**/node_modules/**',
        '.git/**',
        '.build/**',
        'cdk.out/**',
        '**/cdk.out/**',
        'dist/**',
        '**/dist/**',
        '.env',
        '.claude/**',
      ],
    });

    archive.finalize();
  });
}

/**
 * Start a CodeBuild build
 */
async function startBuild(projectName, description, sourceLocation) {
  const codebuild = new CodeBuildClient({});

  console.log(`\n🚀 Starting build for ${description}...`);
  console.log(`   Project: ${projectName}`);
  if (sourceLocation) {
    console.log(`   Source: s3://${sourceLocation}`);
  }

  try {
    const buildCommand = {
      projectName: projectName,
    };

    // Provide source location override for S3 source
    if (sourceLocation) {
      buildCommand.sourceLocationOverride = sourceLocation;
      buildCommand.sourceTypeOverride = 'S3';
      buildCommand.sourceVersion = ''; // Empty version for S3 (not using versioning)
    }

    const response = await codebuild.send(new StartBuildCommand(buildCommand));

    const buildId = response.build?.id;
    const buildNumber = response.build?.buildNumber;
    const region = await codebuild.config.region();

    console.log(`✅ Build started successfully`);
    console.log(`   Build ID: ${buildId}`);
    console.log(`   Build Number: ${buildNumber}`);
    console.log(
      `   Status: ${response.build?.buildStatus || "IN_PROGRESS"}`
    );
    console.log(
      `\n📊 Monitor build progress:\n   https://console.aws.amazon.com/codesuite/codebuild/projects/${projectName}/build/${buildId}/?region=${region}`
    );

    return buildId;
  } catch (error) {
    console.error(`❌ Failed to start build for ${description}`);
    throw error;
  }
}

/**
 * Get build status
 */
async function getBuildStatus(buildId) {
  const codebuild = new CodeBuildClient({});

  try {
    const response = await codebuild.send(
      new BatchGetBuildsCommand({
        ids: [buildId],
      })
    );

    if (
      !response.builds ||
      response.builds.length === 0
    ) {
      return null;
    }

    return response.builds[0].buildStatus;
  } catch (error) {
    console.error(`Failed to get build status: ${error.message}`);
    return null;
  }
}

/**
 * Wait for build to complete (optional)
 */
async function waitForBuild(buildId, description, pollInterval = 10000) {
  console.log(`\n⏳ Waiting for ${description} build to complete...`);
  console.log(`   Polling every ${pollInterval / 1000} seconds`);

  let attempts = 0;
  const maxAttempts = 180; // 30 minutes max (180 * 10s)

  while (attempts < maxAttempts) {
    const status = await getBuildStatus(buildId);

    if (!status) {
      console.error("   ⚠️  Could not retrieve build status");
      break;
    }

    if (status === "SUCCEEDED") {
      console.log(`   ✅ Build completed successfully!`);
      return true;
    } else if (["FAILED", "FAULT", "TIMED_OUT", "STOPPED"].includes(status)) {
      console.error(`   ❌ Build ${status.toLowerCase()}`);
      return false;
    }

    // Still in progress
    process.stdout.write(`\r   Status: ${status} (${attempts + 1}/${maxAttempts})`);

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    attempts++;
  }

  console.log(`\n   ⚠️  Build monitoring timed out`);
  return false;
}

/**
 * Trigger builds for specified project type(s)
 */
async function triggerBuilds(projectType, wait = false) {
  const projectTypes = projectType === "all" ? ["nuke", "frontend"] : [projectType];

  const buildIds = [];

  // Ensure ECR repositories exist before starting builds
  const ecrRegion = process.env.PRIVATE_ECR_REPO_REGION || process.env.AWS_REGION || 'us-east-1';

  for (const type of projectTypes) {
    const config = PROJECT_CONFIG[type];
    const repoName = process.env[config.ecrRepoEnvVar];

    if (repoName) {
      try {
        await ensureEcrRepository(repoName, ecrRegion);
      } catch (error) {
        console.error(`\n❌ Failed to ensure ECR repository for ${config.description}`);
        console.error(`   ${error.message}`);
        process.exit(1);
      }
    }
  }

  // Upload source code once (reused for all builds)
  console.log('\n📦 Preparing source code for CodeBuild...');
  const sourceLocation = await uploadSourceToS3('all');

  // Start all builds
  for (const type of projectTypes) {
    const config = PROJECT_CONFIG[type];

    if (!config) {
      console.error(`❌ Unknown project type: ${type}`);
      console.log(`   Valid types: ${Object.keys(PROJECT_CONFIG).join(", ")}, all`);
      process.exit(1);
    }

    try {
      console.log(`\n🔍 Getting CodeBuild project name for ${config.description}...`);
      const projectName = await getStackOutput(config.stackName, config.outputKey);

      const buildId = await startBuild(projectName, config.description, sourceLocation);
      buildIds.push({ buildId, description: config.description });
    } catch (error) {
      console.error(`\n❌ Error processing ${config.description}:`);
      console.error(`   ${error.message}`);
      process.exit(1);
    }
  }

  // If wait flag is set, wait for all builds to complete
  if (wait && buildIds.length > 0) {
    console.log(`\n${'='.repeat(60)}`);
    console.log("Waiting for all builds to complete...");
    console.log('='.repeat(60));

    const results = [];
    for (const { buildId, description } of buildIds) {
      const success = await waitForBuild(buildId, description);
      results.push({ description, success });
    }

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log("Build Summary:");
    console.log('='.repeat(60));

    for (const { description, success } of results) {
      const icon = success ? "✅" : "❌";
      const status = success ? "SUCCEEDED" : "FAILED";
      console.log(`${icon} ${description}: ${status}`);
    }

    const allSuccess = results.every((r) => r.success);
    if (!allSuccess) {
      process.exit(1);
    }
  } else {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ All builds started successfully!`);
    console.log(`   Check the console URLs above to monitor progress.`);
    console.log('='.repeat(60) + '\n');
  }
}

// Main execution
const projectType = process.argv[2];
const wait = process.argv.includes("--wait") || process.argv.includes("-w");

if (!projectType) {
  console.error("Usage: node scripts/trigger-codebuild.cjs <type> [--wait]");
  console.error("");
  console.error("Types:");
  console.error("  nuke      - Build AWS Nuke container");
  console.error("  frontend  - Build frontend container");
  console.error("  all       - Build both containers");
  console.error("");
  console.error("Options:");
  console.error("  --wait, -w  - Wait for builds to complete");
  console.error("");
  console.error("Examples:");
  console.error("  npm run codebuild:nuke");
  console.error("  npm run codebuild:frontend");
  console.error("  npm run codebuild:build-and-push");
  console.error("  npm run codebuild:build-and-push -- --wait");
  process.exit(1);
}

triggerBuilds(projectType, wait).catch((error) => {
  console.error("\n❌ Fatal error:", error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
