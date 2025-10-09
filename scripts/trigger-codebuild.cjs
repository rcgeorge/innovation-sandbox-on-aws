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

// Configuration for different project types
const PROJECT_CONFIG = {
  nuke: {
    stackName: "InnovationSandbox-CodeBuild",
    outputKey: "NukeCodeBuildProjectName",
    description: "AWS Nuke container",
  },
  frontend: {
    stackName: "InnovationSandbox-CodeBuild",
    outputKey: "FrontendCodeBuildProjectName",
    description: "Frontend container",
  },
};

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
 * Start a CodeBuild build
 */
async function startBuild(projectName, description) {
  const codebuild = new CodeBuildClient({});

  console.log(`\n🚀 Starting build for ${description}...`);
  console.log(`   Project: ${projectName}`);

  try {
    const response = await codebuild.send(
      new StartBuildCommand({
        projectName: projectName,
        // Note: If using NO_SOURCE, you would need to provide sourceLocationOverride
        // For GitHub source, CodeBuild pulls automatically
      })
    );

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

      const buildId = await startBuild(projectName, config.description);
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
