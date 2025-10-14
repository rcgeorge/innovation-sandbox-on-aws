#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Interactive configuration wizard for Innovation Sandbox on AWS
 * This script prompts users for required environment variables and creates a .env file
 *
 * Usage:
 *   npm run configure
 *   npm run configure govcloud                      (recommended - no npm warnings)
 *   npm run configure -- --profile govcloud          (alternative - with double dash)
 *
 * Note: Do NOT use 'npm run configure --profile' (without --) as npm will show warnings
 */

const inquirer = require('inquirer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Parse command-line arguments for --profile
const args = process.argv.slice(2);
const profileArgIndex = args.findIndex(arg => arg.startsWith('--profile'));
let configuredProfile = null;

if (profileArgIndex !== -1) {
  const profileArg = args[profileArgIndex];
  if (profileArg.includes('=')) {
    configuredProfile = profileArg.split('=')[1];
  } else if (args[profileArgIndex + 1] && !args[profileArgIndex + 1].startsWith('--')) {
    configuredProfile = args[profileArgIndex + 1];
  } else {
    console.error('Error: --profile requires a value');
    console.error('Usage: npm run configure -- --profile <profile-name>');
    process.exit(1);
  }

  // Set AWS_PROFILE for this session
  process.env.AWS_PROFILE = configuredProfile;
  console.log(`Using AWS profile: ${configuredProfile}\n`);
} else if (args.length === 1 && !args[0].startsWith('-')) {
  // Fallback: If just a single argument without dashes, treat it as profile name
  // This handles: npm run configure govcloud (without --)
  configuredProfile = args[0];
  process.env.AWS_PROFILE = configuredProfile;
  console.log(`Using AWS profile: ${configuredProfile}\n`);
}

// AWS SDK v3 imports
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { SSOAdminClient, ListInstancesCommand, DescribeInstanceCommand } = require('@aws-sdk/client-sso-admin');
const { OrganizationsClient, ListRootsCommand } = require('@aws-sdk/client-organizations');
const { ECRClient, DescribeRepositoriesCommand, CreateRepositoryCommand, DescribeImagesCommand } = require('@aws-sdk/client-ecr');
const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');
const { EC2Client, DescribeRegionsCommand } = require('@aws-sdk/client-ec2');

const envPath = path.join(__dirname, '..', '.env');
const envExamplePath = path.join(__dirname, '..', '.env.example');

// Load existing .env if it exists
let existingEnv = {};
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  // Split by newline and handle both Windows (CRLF) and Unix (LF) line endings
  envContent.split(/\r?\n/).forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      let value = match[2].trim();
      // Remove surrounding quotes if present
      value = value.replace(/^["']|["']$/g, '');
      existingEnv[match[1].trim()] = value;
    }
  });
}

// Check if existing .env has valid configuration
function hasValidConfiguration() {
  if (!fs.existsSync(envPath)) {
    return false;
  }

  // Check for required fields with actual values (not default placeholders from .env.example)
  // A valid config should have:
  // 1. Real account ID (not 000000000000)
  // 2. A namespace (can be myisb or anything else)
  // 3. Organization root ID or Parent OU ID
  // 4. Identity Store ID
  // 5. SSO Instance ARN
  // Note: IDC_KMS_KEY_ARN is optional for backward compatibility

  const requiredFields = {
    'HUB_ACCOUNT_ID': '000000000000',
    'PARENT_OU_ID': 'ou-abcd-abcd1234',
    'IDENTITY_STORE_ID': 'd-0000000000',
    'SSO_INSTANCE_ARN': 'arn:aws:sso:::instance/ssoins-0000000000000000'
  };

  for (const [field, placeholder] of Object.entries(requiredFields)) {
    if (!existingEnv[field]) {
      return false;
    }
    // Remove quotes if present for comparison
    const cleanValue = existingEnv[field].replace(/^["']|["']$/g, '');
    // Check if it's still the placeholder value from .env.example
    if (cleanValue === placeholder) {
      return false;
    }
    // Special check for fields that might have all zeros
    if (cleanValue.includes('0000000000') && placeholder.includes('0000000000')) {
      return false;
    }
  }

  return true;
}

// Helper function to get AWS credentials configuration
function getAwsConfig(region) {
  const config = {};

  // Use configured profile if available (set via --profile argument)
  if (process.env.AWS_PROFILE) {
    const { fromIni } = require('@aws-sdk/credential-providers');
    config.credentials = fromIni({ profile: process.env.AWS_PROFILE });

    // If no region specified, try to get it from the profile
    if (!region) {
      try {
        const profileRegion = execSync(`aws configure get region --profile ${process.env.AWS_PROFILE}`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        if (profileRegion) {
          config.region = profileRegion;
        }
      } catch (error) {
        // Silently fail - region will be auto-detected by SDK
      }
    } else {
      config.region = region;
    }
  } else if (region) {
    config.region = region;
  }
  // Otherwise, use default credential chain (env vars, default profile, instance role, etc.)

  return config;
}

// Function to get current AWS account ID using AWS SDK
async function getCurrentAwsAccountId(region) {
  try {
    const awsConfig = getAwsConfig(region);
    console.log(`[DEBUG] STS config:`, awsConfig.region ? `region=${awsConfig.region}` : 'no region', process.env.AWS_PROFILE ? `profile=${process.env.AWS_PROFILE}` : 'no profile');
    const client = new STSClient(awsConfig);
    const command = new GetCallerIdentityCommand({});
    const response = await client.send(command);

    if (response.Account && /^\d{12}$/.test(response.Account)) {
      return response.Account;
    }
  } catch (error) {
    console.log(`[DEBUG] STS error:`, error.message);
    // Silently fail and try environment variable
  }

  // Try getting from environment variable
  if (process.env.AWS_ACCOUNT_ID && /^\d{12}$/.test(process.env.AWS_ACCOUNT_ID)) {
    return process.env.AWS_ACCOUNT_ID;
  }

  return null;
}

// Function to get current AWS region
function getCurrentAwsRegion() {
  // First check if AWS_PROFILE is set and get region from that profile
  if (process.env.AWS_PROFILE) {
    // Method 1: Try reading from config file directly
    try {
      console.log(`[DEBUG] Trying to read region from AWS config file for profile: ${process.env.AWS_PROFILE}`);
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      const configPath = path.join(homeDir, '.aws', 'config');

      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        // Look for [profile profileName] or [profileName] section
        const profilePattern = new RegExp(`\\[(profile )?${process.env.AWS_PROFILE}\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'm');
        const match = configContent.match(profilePattern);

        if (match) {
          const profileSection = match[2];
          const regionMatch = profileSection.match(/region\s*=\s*([^\s\n]+)/);
          if (regionMatch) {
            const region = regionMatch[1].trim();
            console.log(`[DEBUG] Region from config file: "${region}"`);
            if (region) return region;
          }
        }
      }
    } catch (error) {
      console.log(`[DEBUG] Error reading config file:`, error.message);
    }

    // Method 2: Try AWS CLI command
    try {
      console.log(`[DEBUG] Trying AWS CLI command for profile: ${process.env.AWS_PROFILE}`);
      const output = execSync(`aws configure get region --profile ${process.env.AWS_PROFILE}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const region = output.trim();
      console.log(`[DEBUG] Region from CLI command: "${region}"`);
      if (region) return region;
    } catch (error) {
      console.log(`[DEBUG] AWS CLI command failed:`, error.message);
      // Fall through to other methods
    }
  }

  // Try to get from AWS CLI default config
  try {
    const output = execSync('aws configure get region', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return output.trim();
  } catch (error) {
    // Try environment variable
    return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null;
  }
}

// Function to get IAM Identity Center instance information using AWS SDK
// IAM Identity Center is a global service but the instance is created in a specific region
async function getIdentityCenterInfo() {
  // First try the current region
  try {
    const client = new SSOAdminClient(getAwsConfig());
    const command = new ListInstancesCommand({});
    const response = await client.send(command);

    if (response.Instances && response.Instances.length > 0) {
      const instance = response.Instances[0];
      const identityStoreId = instance.IdentityStoreId;
      const instanceArn = instance.InstanceArn;

      // Support both commercial and GovCloud ARNs
      if (identityStoreId && instanceArn && instanceArn.match(/^arn:aws(-us-gov)?:sso:::instance\/(sso)?ins-/)) {
        // Get KMS key ARN from instance details
        let kmsKeyArn = null;
        try {
          const describeCommand = new DescribeInstanceCommand({ InstanceArn: instanceArn });
          const describeResponse = await client.send(describeCommand);
          kmsKeyArn = describeResponse.EncryptionConfigurationDetails?.KmsKeyArn || null;
        } catch (error) {
          // KMS key discovery is optional, continue without it
        }
        return { identityStoreId, instanceArn, kmsKeyArn, region: null };
      }
    }
  } catch (error) {
    // Silently fail and try other regions
  }

  // If not found in current region, try common regions where IDC is typically set up
  const commonIdcRegions = ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'us-gov-west-1', 'us-gov-east-1'];

  for (const region of commonIdcRegions) {
    try {
      const client = new SSOAdminClient(getAwsConfig(region));
      const command = new ListInstancesCommand({});
      const response = await client.send(command);

      if (response.Instances && response.Instances.length > 0) {
        const instance = response.Instances[0];
        const identityStoreId = instance.IdentityStoreId;
        const instanceArn = instance.InstanceArn;

        // Support both commercial and GovCloud ARNs
        if (identityStoreId && instanceArn && instanceArn.match(/^arn:aws(-us-gov)?:sso:::instance\/(sso)?ins-/)) {
          // Get KMS key ARN from instance details
          let kmsKeyArn = null;
          try {
            const describeCommand = new DescribeInstanceCommand({ InstanceArn: instanceArn });
            const describeResponse = await client.send(describeCommand);
            kmsKeyArn = describeResponse.EncryptionConfigurationDetails?.KmsKeyArn || null;
          } catch (error) {
            // KMS key discovery is optional, continue without it
          }
          return { identityStoreId, instanceArn, kmsKeyArn, region };
        }
      }
    } catch (error) {
      // Continue to next region
    }
  }

  return { identityStoreId: null, instanceArn: null, kmsKeyArn: null, region: null };
}

// Function to get organization root ID using AWS SDK
async function getOrganizationRootId(region) {
  try {
    const awsConfig = getAwsConfig(region);
    console.log(`[DEBUG] Organizations config:`, awsConfig.region ? `region=${awsConfig.region}` : 'no region');
    const client = new OrganizationsClient(awsConfig);
    const command = new ListRootsCommand({});
    const response = await client.send(command);

    if (response.Roots && response.Roots.length > 0) {
      return response.Roots[0].Id;
    }
  } catch (error) {
    console.log(`[DEBUG] Organizations error:`, error.message);
    // Silently fail
  }
  return null;
}

// Function to get enabled regions for the account using AWS SDK
async function getEnabledRegions(currentRegion) {
  try {
    // Use EC2 DescribeRegions which is more widely available and doesn't require special permissions
    // Must use a valid region for the credentials (e.g., GovCloud credentials need GovCloud region)
    const region = currentRegion || undefined; // Let SDK use default if no region specified
    const awsConfig = getAwsConfig(region);
    console.log(`[DEBUG] EC2 config:`, awsConfig.region ? `region=${awsConfig.region}` : 'no region');
    const client = new EC2Client(awsConfig);
    const command = new DescribeRegionsCommand({
      AllRegions: false // Only get opted-in regions
    });
    const response = await client.send(command);

    if (response.Regions && response.Regions.length > 0) {
      // Extract just the region names and sort them
      const regions = response.Regions
        .map(r => r.RegionName)
        .filter(r => r) // Remove any undefined values
        .sort();
      return regions;
    }
  } catch (error) {
    console.log(`[DEBUG] EC2 error:`, error.message);
    // Silently fail - might not have permissions or API not available in this region
  }
  return null;
}

// Function to get Compute stack outputs using AWS SDK
async function getComputeStackOutputs(namespace) {
  try {
    const stackName = 'InnovationSandbox-Compute';
    const client = new CloudFormationClient(getAwsConfig());
    const command = new DescribeStacksCommand({ StackName: stackName });
    const response = await client.send(command);

    if (response.Stacks && response.Stacks.length > 0) {
      const outputs = response.Stacks[0].Outputs || [];

      // Find the REST API URL output
      const apiUrlOutput = outputs.find(o =>
        o.OutputKey === 'IsbRestApiUrl' ||
        o.OutputKey.includes('RestApi') ||
        o.OutputKey.includes('ApiUrl')
      );

      return {
        restApiUrl: apiUrlOutput ? apiUrlOutput.OutputValue : null
      };
    }
  } catch (error) {
    // Silently fail
  }
  return { restApiUrl: null };
}

// Helper function to check if ECR repository exists using AWS SDK
async function ecrRepositoryExists(repositoryName, region) {
  try {
    const client = new ECRClient(getAwsConfig(region));
    const command = new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] });
    await client.send(command);
    return true;
  } catch (error) {
    return false;
  }
}

// Helper function to create ECR repository using AWS SDK
async function createEcrRepository(repositoryName, region) {
  try {
    const client = new ECRClient(getAwsConfig(region));
    const command = new CreateRepositoryCommand({
      repositoryName,
      imageScanningConfiguration: { scanOnPush: true }
    });
    await client.send(command);
    return true;
  } catch (error) {
    throw new Error(`Failed to create ECR repository: ${error.message}`);
  }
}

// Helper function to check if ECR image exists using AWS SDK
async function ecrImageExists(repositoryName, region, imageTag = 'latest') {
  try {
    const client = new ECRClient(getAwsConfig(region));
    const command = new DescribeImagesCommand({
      repositoryName,
      imageIds: [{ imageTag }]
    });
    const response = await client.send(command);
    return response.imageDetails && response.imageDetails.length > 0;
  } catch (error) {
    return false;
  }
}

// Helper function to detect existing ECR repos by namespace
async function detectExistingEcrRepos(namespace, region) {
  const accountCleanerRepoName = `${namespace}-account-cleaner`;
  const frontendRepoName = `${namespace}-frontend`;

  const result = {
    accountCleaner: null,
    frontend: null
  };

  // Check for account cleaner repo
  const accountCleanerExists = await ecrRepositoryExists(accountCleanerRepoName, region);
  if (accountCleanerExists) {
    const hasImage = await ecrImageExists(accountCleanerRepoName, region, 'latest');
    result.accountCleaner = {
      repoName: accountCleanerRepoName,
      region: region,
      hasLatestImage: hasImage
    };
  }

  // Check for frontend repo
  const frontendExists = await ecrRepositoryExists(frontendRepoName, region);
  if (frontendExists) {
    const hasImage = await ecrImageExists(frontendRepoName, region, 'latest');
    result.frontend = {
      repoName: frontendRepoName,
      region: region,
      hasLatestImage: hasImage
    };
  }

  return result;
}

// Function to deploy stacks in order
async function deployStacks(answers, isGovCloud, currentRegion) {
  console.log('\n==============================================');
  console.log('Starting Deployment Process');
  console.log('==============================================\n');

  // Determine account IDs based on deployment type
  let hubAccountId;
  if (answers.DEPLOYMENT_TYPE === 'single') {
    hubAccountId = answers.SINGLE_ACCOUNT_ID;
  } else {
    hubAccountId = answers.HUB_ACCOUNT_ID;
  }

  const deploymentSteps = [];
  let currentStep = 1;

  try {
    // Step 1: Deploy Commercial Bridge if GovCloud
    if (isGovCloud) {
      console.log(`\n[${currentStep}] Deploying Commercial Bridge to Commercial Account`);
      console.log('================================================\n');

      const { deployCommercial } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'deployCommercial',
          message: 'GovCloud deployment detected. Deploy Commercial Bridge to commercial account now?',
          default: true
        }
      ]);

      if (deployCommercial) {
        try {
          console.log('\n📦 Installing commercial bridge dependencies...');
          execSync('npm run commercial:install', { stdio: 'inherit', env: process.env });

          // If Roles Anywhere is enabled with self-signed CA, generate the CA certificate first
          const usePCA = answers.ROLES_ANYWHERE_CA_TYPE_CHOICE === 'PCA';
          if (answers.ENABLE_ROLES_ANYWHERE && !usePCA) {
            const caCertPath = path.join(__dirname, '..', 'commercial-bridge', 'certs', 'ca.pem');
            if (!fs.existsSync(caCertPath)) {
              console.log('\n🔐 Generating self-signed CA certificate for Roles Anywhere...');
              try {
                execSync('cd commercial-bridge && npm run roles-anywhere:generate-ca', { stdio: 'inherit', env: process.env });
                console.log('✅ CA certificate generated');
              } catch (error) {
                console.error('❌ Failed to generate CA certificate');
                console.error('   Roles Anywhere requires a CA certificate.');
                console.error('   Either generate it manually or enable PCA instead.');
                throw error;
              }
            } else {
              console.log('✓ Self-signed CA certificate already exists');
            }
          }

          console.log('\n🔧 Bootstrapping CDK in commercial account...');
          execSync('npm run commercial:bootstrap', { stdio: 'inherit', env: process.env });

          console.log('\n🚀 Deploying commercial bridge stacks...');
          if (usePCA) {
            console.log('   ⚠️  PCA enabled - This will cost ~$400/month');
          }
          execSync('npm run commercial:deploy', { stdio: 'inherit', env: process.env });

          // If PCA is enabled, issue certificates automatically
          if (usePCA) {
            console.log('\n🔐 Issuing client certificates from PCA...');
            console.log('   This will generate certificates and store them in GovCloud Secrets Manager');

            try {
              execSync('npm run commercial:pca:issue-and-update-secret', { stdio: 'inherit', env: process.env });
              console.log('\n✅ Client certificates issued and stored in GovCloud!');
            } catch (error) {
              console.error('\n❌ Failed to issue certificates from PCA');
              console.error('   You can manually run: npm run commercial:pca:issue-and-update-secret');
              console.error(`   Error: ${error.message}`);
            }
          }

          console.log('\n✅ Commercial Bridge deployment completed!\n');

          // Extract outputs and update .env if needed
          console.log('📋 Extracting Commercial Bridge outputs...');
          try {
            const apiUrl = execSync(
              'aws cloudformation describe-stacks --stack-name CommercialBridge-ApiGateway --query "Stacks[0].Outputs[?OutputKey==\'ApiUrl\'].OutputValue" --output text',
              { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();

            if (apiUrl) {
              console.log(`  ✓ API URL: ${apiUrl}`);
              // Update .env with commercial bridge API URL
              let envContent = fs.readFileSync(envPath, 'utf-8');
              if (!envContent.includes('COMMERCIAL_BRIDGE_API_URL=') || existingEnv.COMMERCIAL_BRIDGE_API_URL === '') {
                envContent = envContent.replace(/^# COMMERCIAL_BRIDGE_API_URL=.*/m, `COMMERCIAL_BRIDGE_API_URL="${apiUrl}"`);
                fs.writeFileSync(envPath, envContent);
                console.log('  ✓ Updated .env with COMMERCIAL_BRIDGE_API_URL');
              }
            }
          } catch (error) {
            console.log('  ⚠️  Could not extract outputs (stack may still be deploying)');
          }

        } catch (error) {
          console.error(`\n❌ Commercial Bridge deployment failed: ${error.message}`);
          console.error('Please fix the issue and run: npm run commercial:deploy\n');
          return;
        }
      } else {
        console.log('\n⚠️  Skipping Commercial Bridge deployment.');
        console.log('   You must deploy it before deploying GovCloud stacks.');
        console.log('   Run: npm run commercial:deploy\n');
        return;
      }
      currentStep++;
    }

    // Step 2: Bootstrap main CDK
    console.log(`\n[${currentStep}] Bootstrapping CDK in Target Account(s)`);
    console.log('================================================\n');

    const { bootstrapNow } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'bootstrapNow',
        message: answers.DEPLOYMENT_TYPE === 'multi'
          ? 'Bootstrap CDK in hub account? (You\'ll need to bootstrap org/idc accounts separately)'
          : 'Bootstrap CDK now?',
        default: true
      }
    ]);

    if (bootstrapNow) {
      try {
        console.log('\n🔧 Running CDK bootstrap...');
        execSync('npm run bootstrap', { stdio: 'inherit', env: process.env });
        console.log('\n✅ CDK bootstrap completed!\n');
      } catch (error) {
        console.error(`\n❌ Bootstrap failed: ${error.message}`);
        console.error('Please fix the issue and run: npm run bootstrap\n');
        return;
      }
    } else {
      console.log('\n⚠️  Skipping bootstrap. Make sure to run "npm run bootstrap" before deploying.\n');
      return;
    }
    currentStep++;

    // Step 3: Deploy stacks
    console.log(`\n[${currentStep}] Deploying Innovation Sandbox Stacks`);
    console.log('================================================\n');

    const stacksToDeployOrder = [];

    if (answers.DEPLOYMENT_TYPE === 'single') {
      const { deploySingle } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'deploySingle',
          message: 'Deploy all stacks to single account now?',
          default: true
        }
      ]);

      if (deploySingle) {
        try {
          console.log('\n🚀 Deploying all stacks (this may take 15-20 minutes)...');
          execSync('npm run deploy:all', { stdio: 'inherit', env: process.env });
          console.log('\n✅ All stacks deployed successfully!\n');
        } catch (error) {
          console.error(`\n❌ Deployment failed: ${error.message}`);
          console.error('Check the error above and retry the failed stack.\n');
          return;
        }
      }
    } else {
      // Multi-account deployment - deploy each stack individually
      const stackDeployments = [
        { name: 'account-pool', label: 'AccountPool Stack (Org Management Account)', account: answers.ORG_MGT_ACCOUNT_ID },
        { name: 'idc', label: 'IDC Stack (IDC Account)', account: answers.IDC_ACCOUNT_ID },
        { name: 'data', label: 'Data Stack (Hub Account)', account: hubAccountId },
        { name: answers.CONFIGURE_CONTAINER_STACK ? 'container' : 'compute',
          label: `${answers.CONFIGURE_CONTAINER_STACK ? 'Container' : 'Compute'} Stack (Hub Account)`,
          account: hubAccountId
        }
      ];

      for (const stack of stackDeployments) {
        const { deployStack } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'deployStack',
            message: `Deploy ${stack.label} to account ${stack.account}?`,
            default: true
          }
        ]);

        if (deployStack) {
          try {
            console.log(`\n🚀 Deploying ${stack.name} stack...`);
            execSync(`npm run deploy:${stack.name}`, { stdio: 'inherit', env: process.env });
            console.log(`\n✅ ${stack.label} deployed successfully!\n`);
          } catch (error) {
            console.error(`\n❌ ${stack.label} deployment failed: ${error.message}`);
            const { continueDeployment } = await inquirer.prompt([
              {
                type: 'confirm',
                name: 'continueDeployment',
                message: 'Continue with remaining stacks?',
                default: false
              }
            ]);
            if (!continueDeployment) {
              return;
            }
          }
        } else {
          console.log(`\n⚠️  Skipping ${stack.label}`);
          console.log(`   You can deploy it later with: npm run deploy:${stack.name}\n`);
        }
      }
    }

    // Step 4: Optional post-deployment stack
    currentStep++;
    console.log(`\n[${currentStep}] Post-Deployment Configuration (Optional)`);
    console.log('================================================\n');

    const { deployPostDeployment } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'deployPostDeployment',
        message: 'Deploy Post-Deployment stack? (Automates IAM Identity Center SAML configuration)',
        default: false
      }
    ]);

    if (deployPostDeployment) {
      try {
        console.log('\n🚀 Deploying post-deployment stack...');
        execSync('npm run deploy:post-deployment', { stdio: 'inherit', env: process.env });
        console.log('\n✅ Post-deployment stack deployed successfully!\n');
      } catch (error) {
        console.error(`\n❌ Post-deployment failed: ${error.message}`);
      }
    }

    // Show completion message with outputs
    console.log('\n==============================================');
    console.log('🎉 Deployment Complete!');
    console.log('==============================================\n');

    console.log('Next steps:');
    console.log('  1. Access the web UI:');
    if (answers.CONFIGURE_CONTAINER_STACK) {
      console.log('     - Get the ALB URL from Container stack outputs');
    } else {
      console.log('     - Get the CloudFront URL from Compute stack outputs');
    }
    console.log('  2. Review the implementation guide for post-deployment configuration:');
    console.log('     https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/post-deployment-configuration-tasks.html');
    console.log('');

  } catch (error) {
    console.error(`\n❌ Deployment process failed: ${error.message}\n`);
  }
}

async function main() {
  console.log('\n==============================================');
  console.log('Innovation Sandbox on AWS - Configuration Wizard');
  console.log('==============================================\n');

  // Check if there's already a valid configuration
  if (hasValidConfiguration()) {
    console.log('✅ Existing configuration detected in .env file\n');

    const { wantToEdit } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'wantToEdit',
        message: 'Do you want to edit the existing configuration values?',
        default: false
      }
    ]);

    if (!wantToEdit) {
      console.log('\n🔍 Verifying configuration and auto-detecting missing values...\n');

      let envContent = fs.readFileSync(envPath, 'utf-8');
      let updated = false;

      // Check and add missing KMS key ARN
      if (!existingEnv.IDC_KMS_KEY_ARN || existingEnv.IDC_KMS_KEY_ARN.includes('00000000-0000-0000-0000-000000000000')) {
        if (existingEnv.SSO_INSTANCE_ARN) {
          // Get IDC region from existing config or detect it (defined outside try/catch for error message)
          const idcRegion = existingEnv.IDC_REGION || getCurrentAwsRegion();

          try {
            console.log('🔍 Discovering IAM Identity Center KMS key...');
            console.log(`   Using region: ${idcRegion}`);
            console.log(`   SSO Instance ARN: ${existingEnv.SSO_INSTANCE_ARN}`);
            const client = new SSOAdminClient({ region: idcRegion });
            const describeCommand = new DescribeInstanceCommand({ InstanceArn: existingEnv.SSO_INSTANCE_ARN });
            const describeResponse = await client.send(describeCommand);
            const kmsKeyArn = describeResponse.EncryptionConfigurationDetails?.KmsKeyArn;

            if (kmsKeyArn) {
              console.log(`✓ Found KMS key: ${kmsKeyArn}`);
              // Add or update the KMS key ARN in .env
              if (envContent.includes('IDC_KMS_KEY_ARN=')) {
                envContent = envContent.replace(/^IDC_KMS_KEY_ARN=.*/m, `IDC_KMS_KEY_ARN="${kmsKeyArn}"`);
              } else {
                // Insert after SSO_INSTANCE_ARN
                envContent = envContent.replace(
                  /^(SSO_INSTANCE_ARN=.*$)/m,
                  `$1\nIDC_KMS_KEY_ARN="${kmsKeyArn}"`
                );
              }
              updated = true;
            } else {
              console.log('✓ IAM Identity Center is using an AWS owned key (no KMS permissions needed)');
              // Set a special value to indicate AWS owned key
              if (envContent.includes('IDC_KMS_KEY_ARN=')) {
                envContent = envContent.replace(/^IDC_KMS_KEY_ARN=.*/m, `IDC_KMS_KEY_ARN="AWS_OWNED_KEY"`);
              } else {
                // Insert after SSO_INSTANCE_ARN
                envContent = envContent.replace(
                  /^(SSO_INSTANCE_ARN=.*$)/m,
                  `$1\nIDC_KMS_KEY_ARN="AWS_OWNED_KEY"`
                );
              }
              updated = true;
            }
          } catch (error) {
            console.log('⚠️  Could not auto-detect KMS key (permission denied)');
            console.log('   Assuming AWS owned key (default configuration)...');

            // Set AWS_OWNED_KEY as the default since most deployments use AWS owned keys
            // and this is the safest assumption when we can't query the instance
            if (envContent.includes('IDC_KMS_KEY_ARN=')) {
              envContent = envContent.replace(/^IDC_KMS_KEY_ARN=.*/m, `IDC_KMS_KEY_ARN="AWS_OWNED_KEY"`);
            } else {
              // Insert after SSO_INSTANCE_ARN
              envContent = envContent.replace(
                /^(SSO_INSTANCE_ARN=.*$)/m,
                `$1\nIDC_KMS_KEY_ARN="AWS_OWNED_KEY"`
              );
            }
            updated = true;

            console.log('✓ Set IDC_KMS_KEY_ARN="AWS_OWNED_KEY"');
            console.log('\n   Note: If you are using a customer-managed KMS key, update .env with:');
            console.log('   IDC_KMS_KEY_ARN="arn:aws-us-gov:kms:region:account:key/key-id"\n');
          }
        }
      } else {
        console.log('✓ KMS key already configured');
      }

      // Check and add missing ECR repos
      const missingEcrInEnv = !existingEnv.PRIVATE_ECR_REPO && !existingEnv.PRIVATE_ECR_FRONTEND_REPO;

      if (missingEcrInEnv && existingEnv.NAMESPACE) {
        console.log('🔍 Checking for existing ECR repositories...');
        const currentRegion = getCurrentAwsRegion();
        const ecrRegion = currentRegion || 'us-east-1';
        const detectedEcrRepos = await detectExistingEcrRepos(existingEnv.NAMESPACE, ecrRegion);

        if (detectedEcrRepos.accountCleaner || detectedEcrRepos.frontend) {
          if (detectedEcrRepos.accountCleaner) {
            console.log(`✓ Found account cleaner ECR repository: ${detectedEcrRepos.accountCleaner.repoName}`);
            envContent = envContent.replace(/^# PRIVATE_ECR_REPO=.*/m, `PRIVATE_ECR_REPO="${detectedEcrRepos.accountCleaner.repoName}"`);
            envContent = envContent.replace(/^# PRIVATE_ECR_REPO_REGION=.*/m, `PRIVATE_ECR_REPO_REGION="${detectedEcrRepos.accountCleaner.region}"`);
            updated = true;
          }

          if (detectedEcrRepos.frontend) {
            console.log(`✓ Found frontend ECR repository: ${detectedEcrRepos.frontend.repoName}`);
            envContent = envContent.replace(/^# PRIVATE_ECR_FRONTEND_REPO=.*/m, `PRIVATE_ECR_FRONTEND_REPO="${detectedEcrRepos.frontend.repoName}"`);
            updated = true;
          }
        } else {
          console.log('⚠️  No existing ECR repositories found for this namespace');
        }
      } else if (existingEnv.PRIVATE_ECR_REPO || existingEnv.PRIVATE_ECR_FRONTEND_REPO) {
        console.log('✓ ECR repositories already configured');
      }

      // Write updated .env if changes were made
      if (updated) {
        fs.writeFileSync(envPath, envContent);
        console.log('\n✅ Updated .env file with auto-detected values\n');

        // Reload existingEnv with new values
        existingEnv = {};
        const updatedEnvContent = fs.readFileSync(envPath, 'utf-8');
        updatedEnvContent.split(/\r?\n/).forEach(line => {
          const match = line.match(/^([^#=]+)=(.*)$/);
          if (match) {
            let value = match[2].trim();
            // Remove surrounding quotes if present
            value = value.replace(/^["']|["']$/g, '');
            existingEnv[match[1].trim()] = value;
          }
        });
      } else {
        console.log('\n✅ Configuration is up to date\n');
      }

      // User doesn't want to edit - exit
      console.log('To deploy, follow the commands in the README.md or run the wizard again with editing enabled.\n');
      return;
    }
    // If user wants to edit, continue with the wizard showing existing values as defaults
    console.log('\n📝 Continuing with configuration wizard. Existing values will be shown as defaults.\n');
  }

  if (Object.keys(existingEnv).length > 0) {
    console.log('ℹ️  Existing .env file found. Current values will be shown as defaults.\n');
  }

  // Detect AWS environment information
  console.log('🔍 Detecting AWS environment configuration...\n');

  // Get Identity Center first (it's global and doesn't need a region)
  const identityCenter = await getIdentityCenterInfo();

  // Get region - try auto-detection first
  let currentRegion = getCurrentAwsRegion();
  console.log(`[DEBUG] Detected region: ${currentRegion || 'none'}`);

  // If region detection failed, prompt the user
  if (!currentRegion) {
    console.log('\n⚠️  Region could not be auto-detected from your AWS profile.\n');
    if (process.env.AWS_PROFILE) {
      console.log(`💡 Tip: Configure region for profile '${process.env.AWS_PROFILE}':`);
      console.log(`   aws configure set region ${identityCenter.region || 'us-gov-east-1'} --profile ${process.env.AWS_PROFILE}\n`);
    }

    const { manualRegion } = await inquirer.prompt([
      {
        type: 'input',
        name: 'manualRegion',
        message: 'Please enter your AWS region:',
        default: identityCenter.region || 'us-gov-east-1',
        validate: (input) => {
          if (!/^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$/.test(input)) {
            return 'Invalid region format. Examples: us-east-1, us-gov-east-1';
          }
          return true;
        }
      }
    ]);

    currentRegion = manualRegion;
    console.log(`✓ Using region: ${currentRegion}\n`);
  }

  // Now use the detected/manual region for all other calls
  const currentAccountId = await getCurrentAwsAccountId(currentRegion);
  const orgRootId = await getOrganizationRootId(currentRegion);
  const enabledRegions = await getEnabledRegions(currentRegion);

  // Auto-detect GovCloud based on region
  const isGovCloud = currentRegion && currentRegion.includes('-gov-');

  if (currentAccountId) {
    console.log(`✓ AWS Account: ${currentAccountId}`);
  } else {
    console.log('⚠️  AWS Account: Not detected');
  }

  if (currentRegion) {
    const regionType = isGovCloud ? ' (GovCloud)' : ' (Commercial)';
    console.log(`✓ AWS Region: ${currentRegion}${regionType}`);
  } else {
    console.log('⚠️  AWS Region: Not detected');
  }

  if (identityCenter.identityStoreId) {
    const regionInfo = identityCenter.region ? ` (in ${identityCenter.region})` : '';
    console.log(`✓ Identity Center: ${identityCenter.identityStoreId}${regionInfo}`);
  } else {
    console.log('⚠️  Identity Center: Not detected');
  }

  if (orgRootId) {
    console.log(`✓ Organization Root: ${orgRootId}`);
  } else {
    console.log('⚠️  Organization Root: Not detected');
  }

  if (enabledRegions && enabledRegions.length > 0) {
    console.log(`✓ Enabled Regions: ${enabledRegions.length} regions detected`);
  } else {
    console.log('⚠️  Enabled Regions: Not detected');
  }

  console.log('');

  const questions = [
  {
    type: 'list',
    name: 'DEPLOYMENT_TYPE',
    message: 'Deployment type:',
    choices: [
      { name: 'Single Account (all stacks in one AWS account)', value: 'single' },
      { name: 'Multi-Account (stacks distributed across multiple AWS accounts)', value: 'multi' }
    ],
    default: 'single'
  },
  {
    type: 'input',
    name: 'NAMESPACE',
    message: 'Namespace for your deployment (e.g., "myisb"):',
    default: existingEnv.NAMESPACE || 'myisb',
    validate: (input) => {
      if (!input || input.trim() === '') {
        return 'Namespace is required';
      }
      if (!/^[a-z0-9-]+$/.test(input)) {
        return 'Namespace must contain only lowercase letters, numbers, and hyphens';
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'SINGLE_ACCOUNT_ID',
    message: 'AWS Account ID (all stacks will be deployed here):',
    when: (answers) => answers.DEPLOYMENT_TYPE === 'single',
    default: (answers) => {
      // Priority: existing env > detected account > no default
      if (existingEnv.HUB_ACCOUNT_ID && existingEnv.HUB_ACCOUNT_ID !== '000000000000') {
        return existingEnv.HUB_ACCOUNT_ID;
      }
      if (currentAccountId) {
        return currentAccountId;
      }
      return undefined;
    },
    validate: (input) => {
      if (!input || input.trim() === '') {
        return 'AWS Account ID is required. Run "aws configure" to set up AWS CLI credentials.';
      }
      if (!/^\d{12}$/.test(input)) {
        return 'Must be a 12-digit AWS account ID';
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'HUB_ACCOUNT_ID',
    message: 'Hub Account ID (where Compute and Data stacks will be deployed):',
    when: (answers) => answers.DEPLOYMENT_TYPE === 'multi',
    default: existingEnv.HUB_ACCOUNT_ID || '000000000000',
    validate: (input) => {
      if (!/^\d{12}$/.test(input)) {
        return 'Must be a 12-digit AWS account ID';
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'PARENT_OU_ID',
    message: 'Parent OU ID (root OU or organizational unit where sandbox OUs will be created):',
    default: (answers) => {
      if (existingEnv.PARENT_OU_ID) return existingEnv.PARENT_OU_ID;
      if (orgRootId) return orgRootId;
      return undefined; // No default if not detected
    },
    validate: (input) => {
      if (!input || input.trim() === '') {
        return 'Parent OU ID is required';
      }
      if (!/^(r-[0-9a-z]{4,32})|(ou-[0-9a-z]{4,32}-[a-z0-9]{8,32})$/.test(input)) {
        return 'Must be a valid AWS Organizations root ID (r-xxxx) or OU ID (ou-xxxx-xxxxxxxx)';
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'AWS_REGIONS',
    message: 'AWS Regions for sandbox accounts (comma-separated, e.g., "us-east-1,us-west-2"):',
    default: (answers) => {
      // Priority: existing env > detected enabled regions > current region > fallback
      if (existingEnv.AWS_REGIONS) return existingEnv.AWS_REGIONS;
      if (enabledRegions && enabledRegions.length > 0) {
        // Use all enabled regions, comma-separated
        return enabledRegions.join(',');
      }
      if (currentRegion) return currentRegion;
      // Fallback based on deployment type
      return isGovCloud ? 'us-gov-east-1,us-gov-west-1' : 'us-east-1,us-west-2';
    },
    validate: (input) => {
      if (!input || input.trim() === '') {
        return 'At least one region is required';
      }
      const regions = input.split(',').map(r => r.trim());
      // Support both commercial regions (us-east-1) and GovCloud regions (us-gov-east-1)
      const validRegex = /^[a-z]{2}(-gov)?(-[a-z]+-\d{1})$/;
      for (const region of regions) {
        if (!validRegex.test(region)) {
          return `Invalid region format: ${region}. Examples: us-east-1, us-gov-east-1`;
        }
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'AWS_GOVCLOUD_PROFILE',
    message: 'AWS CLI profile name for GovCloud account (leave empty to use default credentials):',
    when: () => isGovCloud,
    default: configuredProfile || existingEnv.AWS_GOVCLOUD_PROFILE || 'default',
    validate: (input) => {
      // Optional field - allow empty
      return true;
    }
  },
  {
    type: 'input',
    name: 'AWS_COMMERCIAL_PROFILE',
    message: 'AWS CLI profile name for Commercial account (for Commercial Bridge):',
    when: () => isGovCloud,
    default: existingEnv.AWS_COMMERCIAL_PROFILE || 'commercial',
    validate: (input) => {
      // Optional field - allow empty
      return true;
    }
  },
  {
    type: 'input',
    name: 'IDC_REGION',
    message: 'AWS Region where IAM Identity Center is configured:',
    when: () => !identityCenter.identityStoreId, // Only ask if IDC was not auto-detected
    default: currentRegion || 'us-east-1',
    validate: (input) => {
      // Support both commercial regions (us-east-1) and GovCloud regions (us-gov-east-1)
      if (!/^[a-z]{2}(-gov)?(-[a-z]+-\d{1})$/.test(input)) {
        return 'Invalid region format. Examples: us-east-1, us-gov-east-1';
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'IDENTITY_STORE_ID',
    message: 'IAM Identity Center Identity Store ID:',
    default: async (answers) => {
      if (existingEnv.IDENTITY_STORE_ID && existingEnv.IDENTITY_STORE_ID !== 'd-0000000000') {
        return existingEnv.IDENTITY_STORE_ID;
      }
      if (identityCenter.identityStoreId) return identityCenter.identityStoreId;

      // If user specified IDC region, try to auto-detect from that region
      if (answers.IDC_REGION) {
        try {
          const client = new SSOAdminClient({ region: answers.IDC_REGION });
          const command = new ListInstancesCommand({});
          const response = await client.send(command);

          if (response.Instances && response.Instances.length > 0) {
            const id = response.Instances[0].IdentityStoreId;
            if (id && /^d-[0-9a-z]{10}$/.test(id)) {
              return id;
            }
          }
        } catch (error) {
          // Silently fail
        }
      }

      return undefined; // No default if not detected
    },
    validate: (input) => {
      if (!input || input.trim() === '') {
        return 'Identity Store ID is required';
      }
      if (!/^d-[0-9a-z]{10}$/.test(input)) {
        return 'Must be a valid Identity Store ID (format: d-xxxxxxxxxx)';
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'SSO_INSTANCE_ARN',
    message: 'IAM Identity Center SSO Instance ARN:',
    default: async (answers) => {
      if (existingEnv.SSO_INSTANCE_ARN && existingEnv.SSO_INSTANCE_ARN !== 'arn:aws:sso:::instance/ssoins-0000000000000000') {
        return existingEnv.SSO_INSTANCE_ARN;
      }
      if (identityCenter.instanceArn) return identityCenter.instanceArn;

      // If user specified IDC region, try to auto-detect from that region
      if (answers.IDC_REGION) {
        try {
          const client = new SSOAdminClient({ region: answers.IDC_REGION });
          const command = new ListInstancesCommand({});
          const response = await client.send(command);

          if (response.Instances && response.Instances.length > 0) {
            const arn = response.Instances[0].InstanceArn;
            // Support both commercial and GovCloud ARNs
            if (arn && arn.match(/^arn:aws(-us-gov)?:sso:::instance\/(sso)?ins-/)) {
              return arn;
            }
          }
        } catch (error) {
          // Silently fail
        }
      }

      return undefined; // No default if not detected
    },
    validate: (input) => {
      if (!input || input.trim() === '') {
        return 'SSO Instance ARN is required';
      }
      // Support both commercial (arn:aws:sso:::) and GovCloud (arn:aws-us-gov:sso:::) ARNs
      if (!input.match(/^arn:aws(-us-gov)?:sso:::instance\/(sso)?ins-/)) {
        return 'Must be a valid SSO instance ARN (e.g., arn:aws:sso:::instance/ssoins-...)';
      }
      return true;
    }
  },
  {
    type: 'list',
    name: 'IDC_KMS_KEY_TYPE',
    message: 'Which KMS key is IAM Identity Center using for encryption?',
    choices: [
      { name: 'AWS-owned key (default, no additional permissions needed)', value: 'AWS_OWNED' },
      { name: 'Customer-managed KMS key (requires KMS key ARN)', value: 'CUSTOMER_MANAGED' }
    ],
    default: async (answers) => {
      // Check existing configuration
      if (existingEnv.IDC_KMS_KEY_ARN) {
        if (existingEnv.IDC_KMS_KEY_ARN === 'AWS_OWNED_KEY') {
          return 'AWS_OWNED';
        } else if (existingEnv.IDC_KMS_KEY_ARN.includes('arn:aws')) {
          return 'CUSTOMER_MANAGED';
        }
      }

      // Try to auto-detect from Identity Center
      if (identityCenter.kmsKeyArn) {
        return 'CUSTOMER_MANAGED';
      }

      // Try to discover from SSO instance ARN
      if (answers.SSO_INSTANCE_ARN) {
        try {
          const region = answers.IDC_REGION || await getCurrentAwsRegion();
          const client = new SSOAdminClient({ region });
          const describeCommand = new DescribeInstanceCommand({ InstanceArn: answers.SSO_INSTANCE_ARN });
          const describeResponse = await client.send(describeCommand);
          const kmsKeyArn = describeResponse.EncryptionConfigurationDetails?.KmsKeyArn;
          if (kmsKeyArn) {
            return 'CUSTOMER_MANAGED';
          }
        } catch (error) {
          // Silently fail
        }
      }

      // Default to AWS owned key (most common)
      return 'AWS_OWNED';
    }
  },
  {
    type: 'input',
    name: 'IDC_KMS_KEY_ARN',
    message: 'IAM Identity Center Customer-Managed KMS Key ARN:',
    when: (answers) => answers.IDC_KMS_KEY_TYPE === 'CUSTOMER_MANAGED',
    default: async (answers) => {
      if (existingEnv.IDC_KMS_KEY_ARN && existingEnv.IDC_KMS_KEY_ARN !== 'AWS_OWNED_KEY' && !existingEnv.IDC_KMS_KEY_ARN.includes('00000000-0000-0000-0000-000000000000')) {
        return existingEnv.IDC_KMS_KEY_ARN;
      }
      if (identityCenter.kmsKeyArn) return identityCenter.kmsKeyArn;

      // Try to discover from SSO instance ARN
      if (answers.SSO_INSTANCE_ARN) {
        try {
          const region = answers.IDC_REGION || await getCurrentAwsRegion();
          const client = new SSOAdminClient({ region });
          const describeCommand = new DescribeInstanceCommand({ InstanceArn: answers.SSO_INSTANCE_ARN });
          const describeResponse = await client.send(describeCommand);
          const kmsKeyArn = describeResponse.EncryptionConfigurationDetails?.KmsKeyArn;
          if (kmsKeyArn) {
            return kmsKeyArn;
          }
        } catch (error) {
          // Silently fail
        }
      }

      return undefined; // No default if not detected
    },
    validate: (input) => {
      if (!input || input.trim() === '') {
        return 'KMS Key ARN is required when using customer-managed key';
      }
      // Support both commercial and GovCloud ARNs
      if (!input.match(/^arn:aws(-us-gov)?:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]+$/)) {
        return 'Must be a valid KMS key ARN (e.g., arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012)';
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'ORG_MGT_ACCOUNT_ID',
    message: 'Organization Management Account ID (where AccountPool stack will be deployed):',
    when: (answers) => answers.DEPLOYMENT_TYPE === 'multi',
    default: existingEnv.ORG_MGT_ACCOUNT_ID || '000000000000',
    validate: (input) => {
      if (!/^\d{12}$/.test(input)) {
        return 'Must be a 12-digit AWS account ID';
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'IDC_ACCOUNT_ID',
    message: 'IAM Identity Center Account ID (where IDC stack will be deployed):',
    when: (answers) => answers.DEPLOYMENT_TYPE === 'multi',
    default: existingEnv.IDC_ACCOUNT_ID || '000000000000',
    validate: (input) => {
      if (!/^\d{12}$/.test(input)) {
        return 'Must be a 12-digit AWS account ID';
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'ADMIN_GROUP_NAME',
    message: 'Admin group name (leave empty to use default <namespace>_IsbAdmins):',
    default: existingEnv.ADMIN_GROUP_NAME || ''
  },
  {
    type: 'input',
    name: 'MANAGER_GROUP_NAME',
    message: 'Manager group name (leave empty to use default <namespace>_IsbManagers):',
    default: existingEnv.MANAGER_GROUP_NAME || ''
  },
  {
    type: 'input',
    name: 'USER_GROUP_NAME',
    message: 'User group name (leave empty to use default <namespace>_IsbUsers):',
    default: existingEnv.USER_GROUP_NAME || ''
  },
  {
    type: 'list',
    name: 'DEPLOYMENT_MODE',
    message: 'Deployment mode:',
    choices: [
      { name: 'Production (with deletion protection)', value: '' },
      { name: 'Development (no deletion protection)', value: 'dev' }
    ],
    default: existingEnv.DEPLOYMENT_MODE || ''
  },
  {
    type: 'confirm',
    name: 'ENABLE_ROLES_ANYWHERE',
    message: 'Enable IAM Roles Anywhere for certificate-based authentication? (Recommended for GovCloud)',
    when: () => isGovCloud,
    default: !!(existingEnv.ENABLE_ROLES_ANYWHERE === 'true')
  },
  {
    type: 'list',
    name: 'ROLES_ANYWHERE_CA_TYPE_CHOICE',
    message: 'Which Certificate Authority do you want to use for Roles Anywhere?',
    when: (answers) => answers.ENABLE_ROLES_ANYWHERE,
    choices: [
      {
        name: 'AWS Private CA - Automated cert management (~$400/month) [RECOMMENDED]',
        value: 'PCA'
      },
      {
        name: 'Self-Signed CA - Manual cert management (free)',
        value: 'SELF_SIGNED'
      }
    ],
    default: () => {
      // Default to PCA for new configurations
      if (existingEnv.ENABLE_PCA === 'true') return 'PCA';
      if (existingEnv.ROLES_ANYWHERE_CA_TYPE === 'SELF_SIGNED') return 'SELF_SIGNED';
      return 'PCA'; // Default to PCA (recommended)
    }
  },
  {
    type: 'input',
    name: 'PCA_CA_COMMON_NAME',
    message: 'PCA Root Certificate Common Name:',
    when: (answers) => answers.ENABLE_ROLES_ANYWHERE && answers.ROLES_ANYWHERE_CA_TYPE_CHOICE === 'PCA',
    default: existingEnv.PCA_CA_COMMON_NAME || 'Commercial Bridge Root CA'
  },
  {
    type: 'input',
    name: 'PCA_CA_ORGANIZATION',
    message: 'PCA Certificate Organization:',
    when: (answers) => answers.ENABLE_ROLES_ANYWHERE && answers.ROLES_ANYWHERE_CA_TYPE_CHOICE === 'PCA',
    default: existingEnv.PCA_CA_ORGANIZATION || 'Innovation Sandbox'
  },
  {
    type: 'confirm',
    name: 'CONFIGURE_CUSTOM_NUKE',
    message: 'Do you want to use a custom AWS Nuke configuration file?',
    default: !!(existingEnv.NUKE_CONFIG_FILE_PATH)
  },
  {
    type: 'input',
    name: 'NUKE_CONFIG_FILE_PATH',
    message: 'Path to custom AWS Nuke configuration file:',
    default: existingEnv.NUKE_CONFIG_FILE_PATH || '',
    when: (answers) => answers.CONFIGURE_CUSTOM_NUKE,
    validate: (input) => {
      if (!input || input.trim() === '') {
        return 'File path is required when using custom nuke config';
      }
      if (!fs.existsSync(input)) {
        return `File not found: ${input}`;
      }
      return true;
    }
  },
  {
    type: 'confirm',
    name: 'ACCEPT_TERMS',
    message: 'Do you accept the Solution Terms of Use? (Required to deploy Compute stack)',
    default: existingEnv.ACCEPT_SOLUTION_TERMS_OF_USE === 'Accept'
  },
  {
    type: 'input',
    name: 'VPC_CIDR',
    message: 'VPC CIDR block for Container stack:',
    when: () => isGovCloud, // Always ask for GovCloud (Container stack required)
    default: existingEnv.VPC_CIDR || '10.0.0.0/16',
    validate: (input) => {
      if (!input || input.trim() === '') {
        return 'VPC CIDR is required for Container stack';
      }
      // Must match the pattern in Container stack
      const cidrRegex = /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])(\/([1][6-9]|[2][0-8]))$/;
      if (!cidrRegex.test(input)) {
        return 'Invalid CIDR block format (must be /16 to /28). Example: 10.0.0.0/16';
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'ALLOWED_IP_RANGES',
    message: 'Allowed IP range for Container stack ALB (single CIDR block):',
    when: () => isGovCloud,
    default: existingEnv.ALLOWED_IP_RANGES || '0.0.0.0/0',
    validate: (input) => {
      if (!input || input.trim() === '') {
        return 'IP range is required';
      }
      const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/([0-9]|[1-2][0-9]|3[0-2])$/;
      if (!cidrRegex.test(input)) {
        return 'Invalid CIDR block format. Example: 0.0.0.0/0 or 10.0.0.0/8';
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'REST_API_URL',
    message: 'REST API URL from Compute stack (leave empty - will be set after Data stack deploys):',
    when: () => isGovCloud,
    default: existingEnv.REST_API_URL || '',
  },
  {
    type: 'input',
    name: 'CERTIFICATE_ARN',
    message: 'ACM Certificate ARN for HTTPS on ALB (leave empty for HTTP only):',
    when: () => isGovCloud,
    default: existingEnv.CERTIFICATE_ARN || '',
    validate: (input) => {
      // Optional - can be empty
      if (input && !input.match(/^arn:aws(-us-gov)?:acm:[a-z0-9-]+:\d{12}:certificate\/.+$/)) {
        return 'Invalid ACM certificate ARN format';
      }
      return true;
    }
  }
];

  try {
    const answers = await inquirer.prompt(questions);

    // For single-account deployments, use the same account ID for all
    let hubAccountId, orgMgtAccountId, idcAccountId;
    if (answers.DEPLOYMENT_TYPE === 'single') {
      hubAccountId = orgMgtAccountId = idcAccountId = answers.SINGLE_ACCOUNT_ID;
      console.log(`\n✓ Single account deployment: Using ${hubAccountId} for all stacks\n`);
    } else {
      hubAccountId = answers.HUB_ACCOUNT_ID;
      orgMgtAccountId = answers.ORG_MGT_ACCOUNT_ID;
      idcAccountId = answers.IDC_ACCOUNT_ID;
    }


    // Build .env content from template
    let envContent = fs.readFileSync(envExamplePath, 'utf-8');

    // Replace values
    envContent = envContent.replace(/^(# )?DEPLOYMENT_MODE=.*/m,
      answers.DEPLOYMENT_MODE ? `DEPLOYMENT_MODE="${answers.DEPLOYMENT_MODE}"` : '# DEPLOYMENT_MODE="dev"');

    // Set IS_GOVCLOUD based on detected region
    envContent = envContent.replace(/^(# )?IS_GOVCLOUD=.*/m,
      `IS_GOVCLOUD="${isGovCloud ? 'true' : 'false'}"`);

    // Set AWS profile names (GovCloud only)
    if (isGovCloud) {
      if (answers.AWS_GOVCLOUD_PROFILE) {
        envContent = envContent.replace(/^(# )?AWS_GOVCLOUD_PROFILE=.*/m, `AWS_GOVCLOUD_PROFILE="${answers.AWS_GOVCLOUD_PROFILE}"`);
      }
      if (answers.AWS_COMMERCIAL_PROFILE) {
        envContent = envContent.replace(/^(# )?AWS_COMMERCIAL_PROFILE=.*/m, `AWS_COMMERCIAL_PROFILE="${answers.AWS_COMMERCIAL_PROFILE}"`);
      }
    }

    envContent = envContent.replace(/^HUB_ACCOUNT_ID=.*/m, `HUB_ACCOUNT_ID=${hubAccountId}`);
    envContent = envContent.replace(/^NAMESPACE=.*/m, `NAMESPACE="${answers.NAMESPACE}"`);
    envContent = envContent.replace(/^PARENT_OU_ID=.*/m, `PARENT_OU_ID="${answers.PARENT_OU_ID}"`);
    envContent = envContent.replace(/^AWS_REGIONS=.*/m, `AWS_REGIONS="${answers.AWS_REGIONS}"`);
    envContent = envContent.replace(/^IDENTITY_STORE_ID=.*/m, `IDENTITY_STORE_ID="${answers.IDENTITY_STORE_ID}"`);
    envContent = envContent.replace(/^SSO_INSTANCE_ARN=.*/m, `SSO_INSTANCE_ARN="${answers.SSO_INSTANCE_ARN}"`);

    // Set IDC region (use detected region from Identity Center or fall back to current region)
    const idcRegion = answers.IDC_REGION || identityCenter.region || currentRegion;
    envContent = envContent.replace(/^IDC_REGION=.*/m, `IDC_REGION="${idcRegion}"`);

    // Handle KMS key based on type selection
    const idcKmsKeyValue = answers.IDC_KMS_KEY_TYPE === 'AWS_OWNED'
      ? 'AWS_OWNED_KEY'
      : answers.IDC_KMS_KEY_ARN;
    envContent = envContent.replace(/^IDC_KMS_KEY_ARN=.*/m, `IDC_KMS_KEY_ARN="${idcKmsKeyValue}"`);

    envContent = envContent.replace(/^ADMIN_GROUP_NAME=.*/m, `ADMIN_GROUP_NAME="${answers.ADMIN_GROUP_NAME}"`);
    envContent = envContent.replace(/^MANAGER_GROUP_NAME=.*/m, `MANAGER_GROUP_NAME="${answers.MANAGER_GROUP_NAME}"`);
    envContent = envContent.replace(/^USER_GROUP_NAME=.*/m, `USER_GROUP_NAME="${answers.USER_GROUP_NAME}"`);
    envContent = envContent.replace(/^ORG_MGT_ACCOUNT_ID=.*/m, `ORG_MGT_ACCOUNT_ID=${orgMgtAccountId}`);
    envContent = envContent.replace(/^IDC_ACCOUNT_ID=.*/m, `IDC_ACCOUNT_ID=${idcAccountId}`);
    envContent = envContent.replace(/^ACCEPT_SOLUTION_TERMS_OF_USE=.*/m,
      `ACCEPT_SOLUTION_TERMS_OF_USE="${answers.ACCEPT_TERMS ? 'Accept' : ''}"`);

    // Handle optional custom nuke config
    if (answers.CONFIGURE_CUSTOM_NUKE) {
      envContent = envContent.replace(/^# NUKE_CONFIG_FILE_PATH=.*/m, `NUKE_CONFIG_FILE_PATH="${answers.NUKE_CONFIG_FILE_PATH}"`);
    }

    // Handle Container stack configuration (for GovCloud)
    if (isGovCloud) {
      if (answers.VPC_CIDR) {
        envContent = envContent.replace(/^# VPC_CIDR=.*/m, `VPC_CIDR="${answers.VPC_CIDR}"`);
      }
      if (answers.ALLOWED_IP_RANGES) {
        envContent = envContent.replace(/^# ALLOWED_IP_RANGES=.*/m, `ALLOWED_IP_RANGES="${answers.ALLOWED_IP_RANGES}"`);
      }
      if (answers.REST_API_URL !== undefined) {
        envContent = envContent.replace(/^# REST_API_URL=.*/m, `REST_API_URL="${answers.REST_API_URL}"`);
      }
      if (answers.CERTIFICATE_ARN !== undefined) {
        envContent = envContent.replace(/^# CERTIFICATE_ARN=.*/m, `CERTIFICATE_ARN="${answers.CERTIFICATE_ARN}"`);
      }
    }

    // Handle Commercial Bridge configuration (GovCloud only)
    if (isGovCloud && answers.ENABLE_ROLES_ANYWHERE) {
      const usePCA = answers.ROLES_ANYWHERE_CA_TYPE_CHOICE === 'PCA';

      // Enable Roles Anywhere
      envContent = envContent.replace(/^# ENABLE_ROLES_ANYWHERE=.*/m, `ENABLE_ROLES_ANYWHERE="true"`);

      // Set CA type
      const caType = answers.ROLES_ANYWHERE_CA_TYPE_CHOICE;
      if (!envContent.includes('ROLES_ANYWHERE_CA_TYPE=')) {
        envContent = envContent.replace(
          /^# ENABLE_ROLES_ANYWHERE=.*/m,
          `ENABLE_ROLES_ANYWHERE="true"\n# ROLES_ANYWHERE_CA_TYPE="${caType}" # CA type for Roles Anywhere (SELF_SIGNED or PCA)`
        );
      } else {
        envContent = envContent.replace(/^# ROLES_ANYWHERE_CA_TYPE=.*/m, `ROLES_ANYWHERE_CA_TYPE="${caType}"`);
      }

      // If using PCA, enable PCA stack and set configuration
      if (usePCA) {
        envContent = envContent.replace(/^# ENABLE_PCA=.*/m, `ENABLE_PCA="true"`);
        if (answers.PCA_CA_COMMON_NAME) {
          envContent = envContent.replace(/^# PCA_CA_COMMON_NAME=.*/m, `PCA_CA_COMMON_NAME="${answers.PCA_CA_COMMON_NAME}"`);
        }
        if (answers.PCA_CA_ORGANIZATION) {
          envContent = envContent.replace(/^# PCA_CA_ORGANIZATION=.*/m, `PCA_CA_ORGANIZATION="${answers.PCA_CA_ORGANIZATION}"`);
        }
      }
    }

    // Write .env file
    fs.writeFileSync(envPath, envContent);

    console.log('\n✅ Configuration saved to .env file!\n');

    // Print deployment instructions
    printDeploymentInstructions(answers, isGovCloud, currentRegion);

  } catch (error) {
    if (error.isTtyError) {
      console.error('\n❌ Error: Interactive prompts not available in this environment.');
      console.error('Please manually copy .env.example to .env and configure it.\n');
    } else {
      console.error('\n❌ Configuration failed:', error.message);
    }
    process.exit(1);
  }
}

// Function to print deployment instructions
function printDeploymentInstructions(answers, isGovCloud, currentRegion) {
  console.log('==============================================');
  console.log('📋 Deployment Instructions');
  console.log('==============================================\n');

  console.log('Configuration complete! Follow these steps to deploy:\n');

  let step = 1;

  // Commercial Bridge for GovCloud
  if (isGovCloud && answers.ENABLE_ROLES_ANYWHERE) {
    console.log(`STEP ${step}: Deploy Commercial Bridge (Commercial AWS Account)`);
    console.log('─'.repeat(60));
    if (answers.AWS_COMMERCIAL_PROFILE) {
      console.log(`Using profile: ${answers.AWS_COMMERCIAL_PROFILE}\n`);
    }
    console.log('# IMPORTANT: Delete stale CDK output first');
    console.log('rm -r commercial-bridge/infrastructure/cdk.out\n');
    console.log('npm run commercial:install');
    console.log('npm run commercial:bootstrap\n');

    if (answers.ROLES_ANYWHERE_CA_TYPE_CHOICE === 'SELF_SIGNED') {
      console.log('# Generate self-signed CA certificate');
      console.log('cd commercial-bridge && npm run roles-anywhere:generate-ca\n');
    }

    console.log('npm run commercial:deploy');

    if (answers.ROLES_ANYWHERE_CA_TYPE_CHOICE === 'PCA') {
      console.log('npm run commercial:pca:issue-and-update-secret');
      console.log('\n⚠️  PCA costs ~$400/month');
    }

    console.log('\n# Extract outputs and update .env automatically');
    console.log('npm run commercial:extract-outputs\n');
    step++;
  }

  // Main deployment - Bootstrap and core stacks
  console.log(`STEP ${step}: Bootstrap and Deploy Core Stacks`);
  console.log('─'.repeat(60));
  console.log('# Bootstrap CDK');
  console.log('npm run bootstrap\n');

  console.log('# Deploy core stacks');
  console.log('npm run deploy:account-pool  # Org Management Account');
  console.log('npm run deploy:idc           # IDC Account');
  console.log('npm run deploy:data          # Hub Account\n');
  step++;

  // For GovCloud: Build images BEFORE Container stack
  if (isGovCloud) {
    console.log(`STEP ${step}: Build and Push Container Images`);
    console.log('─'.repeat(60));
    console.log('Build images BEFORE deploying Container stack.');
    console.log('These commands create ECR repositories AND push images.\n');
    console.log('Account Cleaner Image - Choose ONE option:\n');
    console.log('  Option A: Local Docker Build');
    console.log('    npm run docker:build-and-push');
    console.log('    (Creates myisb-account-cleaner repo + builds + pushes)\n');
    console.log('  Option B: AWS CodeBuild (No Docker required)');
    console.log('    npm run deploy:codebuild  # Deploys CodeBuild stack');
    console.log('    npm run codebuild:nuke');
    console.log('    (Creates repo + triggers CodeBuild + pushes)\n');
    console.log('Frontend Image:\n');
    console.log('  Option A: Local Docker Build');
    console.log('    npm run docker:frontend:build-and-push');
    console.log('    (Creates myisb-frontend repo + builds + pushes)\n');
    console.log('  Option B: AWS CodeBuild (No Docker required)');
    console.log('    npm run codebuild:frontend');
    console.log('    (Creates repo + triggers CodeBuild + pushes)\n');
    step++;

    console.log(`STEP ${step}: Deploy Container Stack`);
    console.log('─'.repeat(60));
    console.log('After images are built, deploy Container stack:');
    console.log('npm run deploy:container\n');
    step++;
  } else {
    console.log(`STEP ${step}: Deploy Compute Stack`);
    console.log('─'.repeat(60));
    console.log('npm run deploy:compute\n');
    step++;
  }

  // Post-deployment
  console.log(`STEP ${step}: Post-Deployment (Optional)`);
  console.log('─'.repeat(60));
  console.log('npm run deploy:post-deployment\n');

  // Tips
  console.log('==============================================');
  console.log('💡 Tips');
  console.log('==============================================\n');

  if (answers.DEPLOYMENT_TYPE === 'multi') {
    console.log('For multi-account deployments with different profiles:');
    console.log('  npm run deploy:account-pool -- --profile org-management');
    console.log('  npm run deploy:idc -- --profile idc-account');
    console.log('  npm run deploy:data -- --profile hub-account\n');
  }

  if (isGovCloud && (answers.AWS_GOVCLOUD_PROFILE || answers.AWS_COMMERCIAL_PROFILE)) {
    console.log('Configured AWS Profiles:');
    if (answers.AWS_GOVCLOUD_PROFILE) {
      console.log(`  GovCloud deployments → ${answers.AWS_GOVCLOUD_PROFILE}`);
    }
    if (answers.AWS_COMMERCIAL_PROFILE) {
      console.log(`  Commercial Bridge → ${answers.AWS_COMMERCIAL_PROFILE}`);
    }
    console.log('Commands will automatically use the correct profile.\n');
  } else if (process.env.AWS_PROFILE) {
    console.log(`Using profile '${process.env.AWS_PROFILE}' for deployments.`);
    console.log('Commands will automatically use this profile via AWS_PROFILE env var.\n');
  }

  console.log('Review your .env file before deploying:');
  console.log('  cat .env\n');

  console.log('⚠️  IMPORTANT:');
  console.log('  Before deploying Commercial Bridge:');
  console.log('    rm -r commercial-bridge/infrastructure/cdk.out');
  console.log('    (Deletes stale CDK synthesis - ensures correct account/region)');
  console.log('');
  console.log('  After deploying Commercial Bridge:');
  console.log('    npm run commercial:extract-outputs');
  console.log('    (Automatically updates .env with API URLs and ARNs)\n');

  console.log('For help:');
  console.log('  See README.md or the implementation guide\n');
}

main();
