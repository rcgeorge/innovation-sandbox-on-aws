#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Interactive configuration wizard for Innovation Sandbox on AWS
 * This script prompts users for required environment variables and creates a .env file
 */

const inquirer = require('inquirer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const envExamplePath = path.join(__dirname, '..', '.env.example');

// Load existing .env if it exists
let existingEnv = {};
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      existingEnv[match[1].trim()] = match[2].trim();
    }
  });
}

// Function to get current AWS account ID
function getCurrentAwsAccountId() {
  try {
    // First try the standard AWS CLI command
    const output = execSync('aws sts get-caller-identity --query Account --output text', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    });
    const accountId = output.trim();
    if (accountId && /^\d{12}$/.test(accountId)) {
      return accountId;
    }
  } catch (error) {
    // Silently fail and try alternative methods
  }

  // Try getting from environment variable
  if (process.env.AWS_ACCOUNT_ID && /^\d{12}$/.test(process.env.AWS_ACCOUNT_ID)) {
    return process.env.AWS_ACCOUNT_ID;
  }

  // Try JSON output format as fallback
  try {
    const output = execSync('aws sts get-caller-identity --output json', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    });
    const data = JSON.parse(output);
    if (data.Account && /^\d{12}$/.test(data.Account)) {
      return data.Account;
    }
  } catch (error) {
    // Silently fail
  }

  return null;
}

// Function to get current AWS region
function getCurrentAwsRegion() {
  try {
    // Try to get from AWS CLI config
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

// Function to get IAM Identity Center instance information
// IAM Identity Center is a global service but the instance is created in a specific region
function getIdentityCenterInfo() {
  // First try the current region
  try {
    const output = execSync('aws sso-admin list-instances --query "Instances[0].[IdentityStoreId,InstanceArn]" --output text', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    });
    const [identityStoreId, instanceArn] = output.trim().split(/\s+/);
    // Support both commercial and GovCloud ARNs
    if (identityStoreId && instanceArn && identityStoreId !== 'None' && instanceArn !== 'None'
        && instanceArn.match(/^arn:aws(-us-gov)?:sso:::instance\/(sso)?ins-/)) {
      return { identityStoreId, instanceArn, region: null };
    }
  } catch (error) {
    // Silently fail and try other regions
  }

  // If not found in current region, try common regions where IDC is typically set up
  const commonIdcRegions = ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'us-gov-west-1', 'us-gov-east-1'];

  for (const region of commonIdcRegions) {
    try {
      const output = execSync(`aws sso-admin list-instances --region ${region} --query "Instances[0].[IdentityStoreId,InstanceArn]" --output text`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000
      });
      const [identityStoreId, instanceArn] = output.trim().split(/\s+/);
      // Support both commercial and GovCloud ARNs
      if (identityStoreId && instanceArn && identityStoreId !== 'None' && instanceArn !== 'None'
          && instanceArn.match(/^arn:aws(-us-gov)?:sso:::instance\/(sso)?ins-/)) {
        return { identityStoreId, instanceArn, region };
      }
    } catch (error) {
      // Continue to next region
    }
  }

  return { identityStoreId: null, instanceArn: null, region: null };
}

// Function to get organization root ID
function getOrganizationRootId() {
  try {
    const output = execSync('aws organizations list-roots --query "Roots[0].Id" --output text', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return output.trim();
  } catch (error) {
    return null;
  }
}

console.log('\n==============================================');
console.log('Innovation Sandbox on AWS - Configuration Wizard');
console.log('==============================================\n');

if (Object.keys(existingEnv).length > 0) {
  console.log('ℹ️  Existing .env file found. Current values will be shown as defaults.\n');
}

// Detect AWS environment information
console.log('🔍 Detecting AWS environment configuration...\n');

const currentAccountId = getCurrentAwsAccountId();
const currentRegion = getCurrentAwsRegion();
const identityCenter = getIdentityCenterInfo();
const orgRootId = getOrganizationRootId();

if (currentAccountId) {
  console.log(`✓ AWS Account: ${currentAccountId}`);
} else {
  console.log('⚠️  AWS Account: Not detected');
}

if (currentRegion) {
  console.log(`✓ AWS Region: ${currentRegion}`);
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
      if (existingEnv.AWS_REGIONS) return existingEnv.AWS_REGIONS;
      if (currentRegion) return currentRegion;
      return 'us-east-1,us-west-2'; // Keep sensible default for regions
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
    default: (answers) => {
      if (existingEnv.IDENTITY_STORE_ID && existingEnv.IDENTITY_STORE_ID !== 'd-0000000000') {
        return existingEnv.IDENTITY_STORE_ID;
      }
      if (identityCenter.identityStoreId) return identityCenter.identityStoreId;

      // If user specified IDC region, try to auto-detect from that region
      if (answers.IDC_REGION) {
        try {
          const output = execSync(`aws sso-admin list-instances --region ${answers.IDC_REGION} --query "Instances[0].IdentityStoreId" --output text`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000
          });
          const id = output.trim();
          if (id && id !== 'None' && /^d-[0-9a-z]{10}$/.test(id)) {
            return id;
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
    default: (answers) => {
      if (existingEnv.SSO_INSTANCE_ARN && existingEnv.SSO_INSTANCE_ARN !== 'arn:aws:sso:::instance/ssoins-0000000000000000') {
        return existingEnv.SSO_INSTANCE_ARN;
      }
      if (identityCenter.instanceArn) return identityCenter.instanceArn;

      // If user specified IDC region, try to auto-detect from that region
      if (answers.IDC_REGION) {
        try {
          const output = execSync(`aws sso-admin list-instances --region ${answers.IDC_REGION} --query "Instances[0].InstanceArn" --output text`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000
          });
          const arn = output.trim();
          // Support both commercial and GovCloud ARNs
          if (arn && arn !== 'None' && arn.match(/^arn:aws(-us-gov)?:sso:::instance\/(sso)?ins-/)) {
            return arn;
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
    type: 'confirm',
    name: 'ACCEPT_TERMS',
    message: 'Do you accept the Solution Terms of Use? (Required to deploy Compute stack)',
    default: existingEnv.ACCEPT_SOLUTION_TERMS_OF_USE === 'Accept'
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
    name: 'CONFIGURE_PRIVATE_ECR',
    message: 'Do you want to configure a private ECR repository for the account cleaner image?',
    default: !!(existingEnv.PRIVATE_ECR_REPO)
  },
  {
    type: 'input',
    name: 'PRIVATE_ECR_REPO',
    message: 'Private ECR repository name:',
    default: existingEnv.PRIVATE_ECR_REPO || '',
    when: (answers) => answers.CONFIGURE_PRIVATE_ECR,
    validate: (input) => {
      if (!input || input.trim() === '') {
        return 'Repository name is required when using private ECR';
      }
      return true;
    }
  },
  {
    type: 'input',
    name: 'PRIVATE_ECR_REPO_REGION',
    message: 'Private ECR repository region:',
    default: existingEnv.PRIVATE_ECR_REPO_REGION || 'us-east-1',
    when: (answers) => answers.CONFIGURE_PRIVATE_ECR,
    validate: (input) => {
      // Support both commercial regions (us-east-1) and GovCloud regions (us-gov-east-1)
      if (!/^[a-z]{2}(-gov)?(-[a-z]+-\d{1})$/.test(input)) {
        return 'Invalid region format. Examples: us-east-1, us-gov-east-1';
      }
      return true;
    }
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
  }
];

async function main() {
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

    envContent = envContent.replace(/^HUB_ACCOUNT_ID=.*/m, `HUB_ACCOUNT_ID=${hubAccountId}`);
    envContent = envContent.replace(/^NAMESPACE=.*/m, `NAMESPACE="${answers.NAMESPACE}"`);
    envContent = envContent.replace(/^PARENT_OU_ID=.*/m, `PARENT_OU_ID="${answers.PARENT_OU_ID}"`);
    envContent = envContent.replace(/^AWS_REGIONS=.*/m, `AWS_REGIONS="${answers.AWS_REGIONS}"`);
    envContent = envContent.replace(/^IDENTITY_STORE_ID=.*/m, `IDENTITY_STORE_ID="${answers.IDENTITY_STORE_ID}"`);
    envContent = envContent.replace(/^SSO_INSTANCE_ARN=.*/m, `SSO_INSTANCE_ARN="${answers.SSO_INSTANCE_ARN}"`);
    envContent = envContent.replace(/^ADMIN_GROUP_NAME=.*/m, `ADMIN_GROUP_NAME="${answers.ADMIN_GROUP_NAME}"`);
    envContent = envContent.replace(/^MANAGER_GROUP_NAME=.*/m, `MANAGER_GROUP_NAME="${answers.MANAGER_GROUP_NAME}"`);
    envContent = envContent.replace(/^USER_GROUP_NAME=.*/m, `USER_GROUP_NAME="${answers.USER_GROUP_NAME}"`);
    envContent = envContent.replace(/^ORG_MGT_ACCOUNT_ID=.*/m, `ORG_MGT_ACCOUNT_ID=${orgMgtAccountId}`);
    envContent = envContent.replace(/^IDC_ACCOUNT_ID=.*/m, `IDC_ACCOUNT_ID=${idcAccountId}`);
    envContent = envContent.replace(/^ACCEPT_SOLUTION_TERMS_OF_USE=.*/m,
      `ACCEPT_SOLUTION_TERMS_OF_USE="${answers.ACCEPT_TERMS ? 'Accept' : ''}"`);

    // Handle optional private ECR configuration
    if (answers.CONFIGURE_PRIVATE_ECR) {
      envContent = envContent.replace(/^# PRIVATE_ECR_REPO=.*/m, `PRIVATE_ECR_REPO="${answers.PRIVATE_ECR_REPO}"`);
      envContent = envContent.replace(/^# PRIVATE_ECR_REPO_REGION=.*/m, `PRIVATE_ECR_REPO_REGION="${answers.PRIVATE_ECR_REPO_REGION}"`);
    }

    // Handle optional custom nuke config
    if (answers.CONFIGURE_CUSTOM_NUKE) {
      envContent = envContent.replace(/^# NUKE_CONFIG_FILE_PATH=.*/m, `NUKE_CONFIG_FILE_PATH="${answers.NUKE_CONFIG_FILE_PATH}"`);
    }

    // Write .env file
    fs.writeFileSync(envPath, envContent);

    console.log('\n✅ Configuration saved to .env file!\n');
    console.log('Next steps:');
    console.log('  1. Review the .env file and make any additional adjustments');
    console.log('  2. Ensure you have AWS CLI configured with appropriate credentials');
    if (answers.DEPLOYMENT_TYPE === 'single') {
      console.log('  3. Run: npm run bootstrap');
      console.log('  4. Run: npm run deploy:all\n');
    } else {
      console.log('  3. Switch AWS credentials to each account as needed');
      console.log('  4. Run: npm run bootstrap');
      console.log('  5. Run deployment commands in order: deploy:account-pool, deploy:idc, deploy:data, deploy:compute\n');
    }

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

main();
