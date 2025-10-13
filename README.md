# Innovation Sandbox on AWS

## Solution Overview

The Innovation Sandbox on AWS solution allows cloud administrators to set up and recycle temporary sandbox environments by automating
the implementation of security and governance policies,spend management mechanisms, and account recycling preferences through a web user interface (UI).
Using the solution, customers can empower their teams to experiment, learn, and innovate with AWS services in production-isolated AWS accounts that are recycled after use.

To find out more about Innovation Sandbox on AWS visit our [AWS Solutions](https://aws.amazon.com/solutions/implementations/innovation-sandbox-on-aws)
page.

## Table of Contents

- [Innovation Sandbox on AWS](#innovation-sandbox-on-aws)
  - [Solution Overview](#solution-overview)
  - [Table of Contents](#table-of-contents)
  - [Architecture](#architecture)
  - [Prerequisites](#prerequisites)
  - [AWS Credentials Configuration](#aws-credentials-configuration)
  - [Environment Variables](#environment-variables)
  - [Deploy the Solution](#deploy-the-solution)
    - [Quick Start - Automated Deployment](#quick-start---automated-deployment)
    - [Deployment Prerequisites](#deployment-prerequisites)
    - [Deploy from the AWS Console](#deploy-from-the-aws-console)
    - [Deploy from Source](#deploy-from-source)
    - [Post Deployment Tasks](#post-deployment-tasks)
  - [Running Tests](#running-tests)
    - [Unit Tests](#unit-tests)
    - [E2E Tests](#e2e-tests)
  - [Using Private ECR Repository](#using-private-ecr-repository)
  - [Commercial Bridge for GovCloud](#commercial-bridge-for-govcloud)
  - [Uninstalling the Solution](#uninstalling-the-solution)
  - [Cost Scaling](#cost-scaling)
  - [File Structure](#file-structure)
  - [Pre-Commit](#pre-commit)
  - [Security Considerations](#security-considerations)
  - [Collection of Operational Metrics](#collection-of-operational-metrics)
  - [License](#license)
  - [Contact Information](#contact-information)
  - [Additional Resources](#additional-resources)

## Architecture

![](./docs/diagrams/architecture/high-level.drawio.svg)

For more details, please refer to the [Architecture Overview](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/architecture-overview.html#architecture-diagram) section of the implementation guide.

## Prerequisites

In order to test, build, and deploy the solution from source the following prerequisites will be required for your development environment:

- MacOS, Amazon Linux 2, or Windows Operating System
- Cloned Repository
- Node 22
- Python (Optional, for pre-commit hooks)
- Pre-Commit (Optional, for automated code checks)
- Docker (Optional, for building ECR images locally - can use CodeBuild instead)
- OpenSSL (Optional, required only for PCA certificate generation in GovCloud deployments)

> **Note for Windows Users:** The solution now supports Windows development environments. All npm scripts have been updated to work cross-platform. The bash scripts in the `deployment/` folder are still Linux/MacOS only, but core development and deployment commands work on Windows.

Once your development environment meets the minimum requirements install the necessary dependencies, navigate to the root of the repository and run:

```shell
npm install
```

## AWS Credentials Configuration

The solution requires AWS credentials to deploy infrastructure. You have several options for providing credentials:

### Option 1: AWS Profiles in .env (Recommended for GovCloud)

For GovCloud deployments that require both commercial and GovCloud credentials, configure profiles in your `.env` file:

```shell
AWS_GOVCLOUD_PROFILE="govcloud"      # Profile for GovCloud account deployments
AWS_COMMERCIAL_PROFILE="commercial"  # Profile for Commercial Bridge deployments
```

**Setup AWS CLI profiles:**

```shell
# Configure GovCloud profile
aws configure --profile govcloud
# Enter GovCloud access key, secret key, and region (e.g., us-gov-east-1)

# Configure commercial profile
aws configure --profile commercial
# Enter commercial access key, secret key, and region (e.g., us-east-1)
```

The `run-with-env` script automatically uses the correct profile:
- Commercial Bridge commands (`npm run commercial:*`) → Uses `AWS_COMMERCIAL_PROFILE`
- GovCloud stack commands → Uses `AWS_GOVCLOUD_PROFILE`

### Option 2: Command-Line Profile Override

Pass `--profile` to any npm script command:

```shell
# Deploy to specific account using a profile
npm run deploy:data -- --profile my-hub-account

# Deploy commercial bridge with commercial profile
npm run commercial:deploy -- --profile commercial
```

### Option 3: Default AWS Credential Chain

If no profiles are configured, the AWS SDK uses the default credential chain:
1. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
2. AWS CLI default profile (`~/.aws/credentials`)
3. EC2/ECS instance role credentials
4. SSO credentials

For single-account deployments, this is the simplest option.

### Multi-Account Deployments

For multi-account deployments, you'll need credentials for each account:
- **Organization Management Account** - For AccountPool stack
- **IDC Account** - For IDC stack
- **Hub Account** - For Data, Compute/Container stacks

Switch profiles between deployments or use separate terminal windows with different `AWS_PROFILE` environment variables.

## Environment Variables

Before you start working from the Innovation Sandbox on AWS repository you must first configure your environment. You have two options:

### Option 1: Interactive Configuration Wizard (Recommended)

Use the interactive wizard to be prompted for all required values:

```shell
npm run configure
```

**For GovCloud or non-default profiles**, specify the AWS profile to use for auto-detection:

```shell
# IMPORTANT: Use double dash (--) before --profile to pass it to the script
npm run configure -- --profile govcloud

# Alternative: Just pass the profile name directly
npm run configure govcloud

# With equals syntax
npm run configure -- --profile=my-aws-profile
```

**Common mistake:** Running `npm run configure --profile govcloud` (single dash) won't work because npm interprets the flag itself. Always use `npm run configure -- --profile govcloud` or `npm run configure govcloud`.

The wizard will use the specified profile to auto-detect your AWS environment (account ID, region, IAM Identity Center, etc.).

The wizard will:
- **Auto-detect** your AWS environment:
  - Current AWS account ID
  - Configured AWS region
  - IAM Identity Center instance information (including KMS key type)
  - AWS Organizations root ID
  - Enabled AWS regions
  - Existing ECR repositories
- **Intelligently handle IAM Identity Center KMS keys**:
  - Auto-detects whether you're using AWS-owned or customer-managed keys
  - Only prompts for KMS ARN when using customer-managed keys
  - Sets `AWS_OWNED_KEY` for AWS-owned keys (skips unnecessary IAM permissions)
- **Optional automated deployment**:
  - For GovCloud: Deploy Commercial Bridge to commercial account first
  - Bootstrap CDK in target accounts
  - Deploy all Innovation Sandbox stacks in correct dependency order
  - Complete end-to-end deployment from configuration to running infrastructure
- Let you choose between single-account or multi-account deployment
- Use detected values as smart defaults to minimize manual input
- Guide you through all required configuration values
- Validate inputs to ensure proper format
- Preserve existing values if you're reconfiguring
- Generate a properly formatted `.env` file

### Option 2: Manual Configuration

Generate a blank `.env` file from the template and manually edit it:

```shell
npm run env:init
```

Then open the `.env` file and configure the required values. The file provides comments explaining each environment variable. Optional variables are not required to deploy the solution.

**Important Notes:**
- **IAM Identity Center KMS Key**: Most deployments use AWS-owned keys. Set `IDC_KMS_KEY_ARN="AWS_OWNED_KEY"` if you're using the default AWS-owned key (recommended). Only provide a KMS ARN if you're using a customer-managed key.
- **GovCloud Deployments**: Additional Commercial Bridge configuration variables are required. See the [Commercial Bridge for GovCloud](#commercial-bridge-for-govcloud) section.

## Deploy the Solution

### Quick Start - Automated Deployment

For the fastest path to deployment:

1. **Configure AWS credentials**: Set up AWS CLI profiles (if multi-account or GovCloud)
   ```shell
   aws configure --profile govcloud
   aws configure --profile commercial  # For GovCloud deployments only
   ```
2. **Install dependencies**: `npm install`
3. **Run configuration wizard**:
   ```shell
   # For default AWS credentials
   npm run configure

   # For GovCloud or specific profile (use double dash --)
   npm run configure -- --profile govcloud
   # Or simply
   npm run configure govcloud
   ```
   - Auto-detects your AWS environment
   - Guides you through all required settings
   - **Optionally deploys all stacks in correct order** (including Commercial Bridge for GovCloud)
4. **Access your deployment**: Get CloudFront or ALB URL from stack outputs

The wizard can handle the complete deployment process, or you can choose to deploy manually using the commands in the sections below.

### Deployment Prerequisites

The solution requires several manual setup steps in your AWS Organization **before** deploying any stacks. These steps cannot be automated and must be completed manually.

#### Required Manual Setup (Before Any Deployment)

**1. AWS Organization Setup**
- Create or use existing AWS Organization
- Identify a "Hub" account for Data and Compute/Container stacks
- **Enable Service Control Policies (SCPs)** in the Organization
  ```shell
  # Enable SCPs in AWS Organizations console or via CLI:
  aws organizations enable-policy-type --root-id r-xxxx --policy-type SERVICE_CONTROL_POLICY
  ```

**2. IAM Identity Center Configuration**
- **Enable IAM Identity Center** at the organization level
- Select a home region for IAM Identity Center
- Note the Identity Store ID and SSO Instance ARN (auto-detected by configuration wizard)

**3. CloudFormation StackSets Trusted Access**
- **Required:** Enable trusted access with AWS Organizations
  ```shell
  # Enable StackSets trusted access
  aws organizations enable-aws-service-access --service-principal member.org.stacksets.cloudformation.amazonaws.com
  ```

**4. AWS Cost Explorer**
- **Enable Cost Explorer** on the Organization Management account
- Allow 24 hours for initial data population
  ```shell
  # Enable via AWS Console: Billing → Cost Explorer → Enable Cost Explorer
  # Or via AWS CLI (if available in your region)
  ```

**5. Amazon SES Configuration (For Email Notifications)**
- Set up Amazon SES in the Hub account
- Verify sender email address or domain
- **Request production access** (required to send emails beyond sandbox limits)
  ```shell
  # Verify email address in SES console
  # Submit production access request in SES console
  ```

**6. AWS Resource Access Manager (RAM)**
- **Enable resource sharing** to allow cross-account sharing
  ```shell
  # Enable in Organizations console or via CLI:
  aws ram enable-sharing-with-aws-organization
  ```

**7. AWS Lambda Quotas**
- Verify Lambda concurrent executions quota is **at least 1000**
- Request quota increase if needed
  ```shell
  # Check current quota
  aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384

  # Request increase if needed
  aws service-quotas request-service-quota-increase --service-code lambda --quota-code L-B99A9384 --desired-value 1000
  ```

**8. For GovCloud Deployments Only**
- Ensure you have access to **both** a commercial AWS account (for Commercial Bridge) and a GovCloud account
- Commercial account must be the Organization Management account or have Organizations delegated permissions

#### Verification Checklist

Before running `npm run configure` or deploying stacks, verify:

- [ ] AWS Organization exists with SCPs enabled
- [ ] IAM Identity Center is enabled and configured
- [ ] CloudFormation StackSets trusted access is enabled
- [ ] Cost Explorer is enabled (and has initial data if checking costs)
- [ ] SES is configured with production access
- [ ] RAM resource sharing is enabled
- [ ] Lambda quotas are sufficient (1000+ concurrent executions)
- [ ] For GovCloud: Access to both commercial and GovCloud accounts
- [ ] AWS CLI configured with appropriate credentials/profiles

For complete details, see the [implementation guide](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/prerequisites.html).

### Deploy from the AWS Console

> **Note:** This deployment method is for **commercial AWS regions only**. GovCloud deployments require the Container stack (instead of Compute) and Commercial Bridge infrastructure. **GovCloud users should use [Deploy from Source](#deploy-from-source) method instead.**

For commercial AWS deployments, use these CloudFormation templates:

| Stack        |                                                                                                          CloudFormation Launch Link                                                                                                           |                                                         S3 Download Link                                                         |
| ------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------: |
| Account Pool | [Launch](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?&templateURL=https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-AccountPool.template&redirectId=GitHub) | [Download](https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-AccountPool.template) |
| IDC          |     [Launch](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?&templateURL=https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-IDC.template&redirectId=GitHub)     |     [Download](https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-IDC.template)     |
| Data         |    [Launch](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?&templateURL=https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-Data.template&redirectId=GitHub)     |    [Download](https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-Data.template)     |
| Compute      |   [Launch](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?&templateURL=https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-Compute.template&redirectId=GitHub)   |   [Download](https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-Compute.template)   |

**Why not GovCloud?** GovCloud deployments require:
- Container stack (ECS/ALB) instead of Compute stack (CloudFront)
- Commercial Bridge infrastructure deployed to a commercial AWS account
- Different configuration context (IS_GOVCLOUD=true)

### Deploy from Source

Deploying the solution from source uses AWS CDK to do so. If you have not already you will need to bootstrap the target accounts with the following command:

```shell
npm run bootstrap
```

**For multi-account deployments**, bootstrap each account separately:

```shell
# Bootstrap using default credentials
npm run bootstrap

# Or bootstrap each account with specific profiles
npm run bootstrap -- --profile hub-account
npm run bootstrap -- --profile org-management
npm run bootstrap -- --profile idc-account
```

To deploy the solution into a single account, run the following command from the repository root:

```shell
npm run deploy:all
```

To deploy the individual cloudformation stacks for a multi-account deployment, use the following commands for each of the stacks:

```shell
npm run deploy:account-pool
npm run deploy:idc
npm run deploy:data
npm run deploy:compute
```

**For multi-account deployments with different AWS credentials per account:**

```shell
# Deploy to Organization Management account
npm run deploy:account-pool -- --profile org-management

# Deploy to IDC account
npm run deploy:idc -- --profile idc-account

# Deploy to Hub account
npm run deploy:data -- --profile hub-account
npm run deploy:compute -- --profile hub-account
```

**For GovCloud Deployments:**

GovCloud deployments require additional infrastructure in a commercial AWS account to access commercial-only APIs (Cost Explorer, Organizations CreateGovCloudAccount).

> **Prerequisites:** Configure AWS CLI profiles for both commercial and GovCloud accounts. See [AWS Credentials Configuration](#aws-credentials-configuration) for setup instructions.

Follow this deployment order:

**Step 1: Deploy Commercial Bridge (Commercial AWS Account)**

If using AWS profiles, these commands automatically use `AWS_COMMERCIAL_PROFILE` from `.env`:

```shell
npm run commercial:install
npm run commercial:bootstrap
npm run commercial:deploy
```

Or explicitly specify a profile:

```shell
npm run commercial:install -- --profile commercial
npm run commercial:bootstrap -- --profile commercial
npm run commercial:deploy -- --profile commercial
```

This deploys the following stacks to your commercial AWS account:
- `CommercialBridge-CostInfo` - Lambda for querying Cost Explorer
- `CommercialBridge-AccountCreation` - Lambda for creating GovCloud accounts
- `CommercialBridge-AcceptInvitation` - Lambda for accepting org invitations
- `CommercialBridge-ApiGateway` - REST API with usage plans and API key

**Optional Commercial Bridge Stacks:**
- `CommercialBridge-PCA` - AWS Private CA for certificate management (~$400/month, set `ENABLE_PCA=true`)
- `CommercialBridge-RolesAnywhere` - IAM Roles Anywhere for cert-based auth (set `ENABLE_ROLES_ANYWHERE=true`)

**Step 2: Deploy GovCloud Stacks (GovCloud Account)**

If using AWS profiles, these commands automatically use `AWS_GOVCLOUD_PROFILE` from `.env`:

```shell
npm run deploy:account-pool
npm run deploy:idc
npm run deploy:data
npm run deploy:container
```

Or explicitly specify a profile:

```shell
npm run deploy:account-pool -- --profile govcloud
npm run deploy:idc -- --profile govcloud
npm run deploy:data -- --profile govcloud
npm run deploy:container -- --profile govcloud
```

The container stack (`InnovationSandbox-Container`) deploys:
- **ECS Fargate** for frontend hosting (replaces CloudFront which is unavailable in GovCloud)
- **Application Load Balancer** for ingress
- **Account cleaner ECS tasks** (same as compute stack)
- All backend Lambda functions and APIs (same as compute stack)

> **Note:** The container stack is required for GovCloud. For commercial regions, use the standard compute stack which uses CloudFront for better performance and lower cost.

> **Tip:** The configuration wizard (`npm run configure`) can automate the entire deployment process for both commercial and GovCloud accounts.

### Post Deployment Tasks

Before the solution is fully functional the post deployment tasks must be completed. See the [implementation guide](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/post-deployment-configuration-tasks.html) for more details.

## Running Tests

### Unit Tests

To run unit tests for all packages in the solution, run the following command from the repository root:

```shell
npm test
```

To also update snapshot tests run the following command from the repository root:

```shell
npm run test:update-snapshots
```

### E2E Tests

First make sure that the `E2E Test Configs` section of the `.env` file is configured.

> **Note:** The E2E tests assume that all stacks are deployed into the same AWS Account for testing purposes. The test suite will not run if you have multi-account deployment.

To run the E2E tests run the following command:

```shell
npm run e2e
```

Additionally, if you want to run the full test suite including slower tests such as those for the account cleaner, run the following command:

```shell
npm run e2e:slow
```

## Using Private ECR Repository

The solution supports using private ECR repositories for hosting Docker images. This is useful for:
- Testing custom AWS Nuke versions (account cleaner)
- Deploying frontend to ECS instead of CloudFront (e.g., in GovCloud where CloudFront is unavailable)
- Hosting images in your own account for security/compliance requirements

### Option 1: Automated Setup via Configuration Wizard (Recommended)

The `npm run configure` wizard can automatically:
- Create ECR repositories in your specified region
- Build Docker images (requires Docker locally)
- Push images to your private ECR repositories

The wizard will prompt for:
1. **Account Cleaner ECR** - For hosting the AWS Nuke container
2. **Frontend ECR** (Optional) - For hosting the frontend container (for ECS deployment)

When prompted, answer yes and follow the prompts. The wizard will handle everything automatically if you have Docker running.

### Option 2: Build Locally with Docker (Requires Docker)

> **Note:** Make sure you have the docker engine installed and running on your machine to perform the steps in this section.

Follow these steps to manually configure deployment to use private ECR images:

**For Account Cleaner:**

1. In the Hub account and desired region, create a new private ECR repository (e.g., `innovation-sandbox-account-cleaner`)
2. Configure your `.env` file with `PRIVATE_ECR_REPO` and `PRIVATE_ECR_REPO_REGION`
3. Build and push the account cleaner image:
   ```shell
   npm run docker:build-and-push
   ```
   This builds the Dockerfile at `source/infrastructure/lib/components/account-cleaner/Dockerfile`

**For Frontend (Optional - for ECS deployment):**

1. In the Hub account and desired region, create a new private ECR repository (e.g., `innovation-sandbox-frontend`)
2. Configure your `.env` file with `PRIVATE_ECR_FRONTEND_REPO`
3. Build and push the frontend image:
   ```shell
   npm run docker:frontend:build-and-push
   ```
   This builds the Dockerfile at `source/frontend/Dockerfile`

### Option 3: Build with CodeBuild (No Local Docker Required)

If you don't have Docker installed locally or prefer to build images in AWS, use the CodeBuild stack. This is ideal for:
- Environments without Docker (Windows without WSL, CI/CD pipelines)
- Building large images that take too long locally
- Teams that prefer cloud-based builds

**Step 1: Deploy CodeBuild Stack**

```shell
npm run deploy:codebuild
```

This creates CodeBuild projects for building and pushing Docker images to your ECR repositories.

**Step 2: Trigger Image Builds**

```shell
# Build and push account cleaner image only
npm run codebuild:nuke

# Build and push frontend image only
npm run codebuild:frontend

# Build and push both images
npm run codebuild:build-and-push
```

The CodeBuild projects will:
1. Pull the source code from your local directory
2. Build the Docker images in AWS CodeBuild (no local Docker needed)
3. Push images to your ECR repositories with `latest` tag
4. Complete in 3-5 minutes per image

**Monitoring builds:**
```shell
# Check build status in AWS Console
# CloudFormation → InnovationSandbox-CodeBuild → Resources → View CodeBuild projects
# Or use AWS CLI
aws codebuild batch-get-builds --ids <build-id>
```

**Prerequisites:**
- CodeBuild stack must be deployed first
- `PRIVATE_ECR_REPO` and/or `PRIVATE_ECR_FRONTEND_REPO` configured in `.env`
- ECR repositories must exist (create manually or use wizard)

**Deploy Changes:**

After building and pushing images, redeploy the compute or container stack to use the new images:
```shell
npm run deploy:compute
# OR
npm run deploy:container
```

## Commercial Bridge for GovCloud

The Commercial Bridge is a separate CDK application deployed to a **commercial AWS account** that provides GovCloud Innovation Sandbox access to commercial-only AWS APIs.

### Why Commercial Bridge is Needed

AWS GovCloud regions don't have direct access to:
1. **AWS Cost Explorer API** - Cost data resides in the commercial partition
2. **Organizations CreateGovCloudAccount API** - Only available in commercial regions

The Commercial Bridge solves this by deploying API endpoints in commercial AWS that the GovCloud deployment can call.

### Architecture

The Commercial Bridge creates the following infrastructure in your commercial AWS account:

**Core Stacks (Always Deployed):**
- `CommercialBridge-CostInfo` - Lambda function with Cost Explorer permissions
- `CommercialBridge-AccountCreation` - Lambda function with Organizations permissions
- `CommercialBridge-AcceptInvitation` - Lambda function for accepting organization invitations
- `CommercialBridge-ApiGateway` - REST API with usage plans, throttling, and API key authentication

**Optional Stacks:**
- `CommercialBridge-PCA` - AWS Private Certificate Authority for certificate management (~$400/month)
  - Provides centralized CA management with automated lifecycle controls
  - Certificate revocation via CRL/OCSP
  - CloudTrail audit of all certificate issuance
  - Set `ENABLE_PCA=true` in `.env` to enable
- `CommercialBridge-RolesAnywhere` - IAM Roles Anywhere for certificate-based authentication
  - Enables secure authentication without long-lived API keys
  - Supports both self-signed and PCA-issued certificates
  - Set `ENABLE_ROLES_ANYWHERE=true` in `.env` to enable

### Deployment Commands

#### Basic Deployment (Core Stacks Only)

From the repository root:

```shell
# Install dependencies
npm run commercial:install

# Bootstrap CDK (one-time setup)
npm run commercial:bootstrap

# Deploy core commercial bridge stacks (CostInfo, AccountCreation, AcceptInvitation, ApiGateway)
npm run commercial:deploy
```

#### Deploying with Optional Stacks (PCA and/or Roles Anywhere)

To deploy optional stacks, configure them in `.env` **before** running `npm run commercial:deploy`:

**Option A: Enable PCA (~$400/month)**

1. Add to your `.env` file:
   ```shell
   ENABLE_PCA="true"
   PCA_CA_COMMON_NAME="Commercial Bridge Root CA"  # Optional, has default
   PCA_CA_ORGANIZATION="Innovation Sandbox"        # Optional, has default
   ```

2. Deploy (includes PCA stack):
   ```shell
   npm run commercial:deploy
   ```

3. **Configure GovCloud Secrets Manager settings** in `.env`:
   ```shell
   GOVCLOUD_SECRET_NAME="/InnovationSandbox/CommercialBridge/ClientCert"  # Optional, has default
   GOVCLOUD_REGION="us-gov-east-1"                                        # Your GovCloud region
   CERT_VALIDITY_DAYS="365"                                               # Optional, default 1 year
   AWS_GOVCLOUD_PROFILE="govcloud"                                        # Your GovCloud AWS profile
   ```

4. Issue client certificates from PCA and store in GovCloud:
   ```shell
   npm run commercial:pca:issue-and-update-secret
   ```

   **This command automatically:**
   - Generates RSA 2048-bit private key
   - Creates Certificate Signing Request (CSR) with CN="govcloud-commercial-bridge"
   - Issues certificate from PCA in commercial account
   - Saves certificate files locally to `commercial-bridge/certs/`
   - **Switches to GovCloud credentials** (uses `AWS_GOVCLOUD_PROFILE`)
   - Creates or updates Secrets Manager secret in GovCloud
   - Stores base64-encoded certificate and private key in secret

   **Requirements:**
   - OpenSSL must be installed (for CSR generation)
   - Commercial AWS credentials configured (for PCA access)
   - GovCloud AWS credentials configured (for Secrets Manager access)

5. Note the secret ARN from output - you'll need it for GovCloud stack deployment.

**Option B: Enable Roles Anywhere (Certificate-based auth)**

1. Add to your `.env` file:
   ```shell
   ENABLE_ROLES_ANYWHERE="true"
   ROLES_ANYWHERE_CA_TYPE="SELF_SIGNED"  # Or "PCA" if using PCA
   ```

2. **If using self-signed certificates (free)**, generate CA first:
   ```shell
   cd commercial-bridge
   npm run roles-anywhere:generate-ca
   ```
   This creates `certs/ca.pem` and `certs/ca.key`.

   **Skip this step if using PCA** - the CA type will automatically use the PCA stack.

3. Deploy (includes RolesAnywhere stack):
   ```shell
   npm run commercial:deploy
   ```

   **Note:** The configuration wizard automatically generates the self-signed CA if needed.

**Option C: Both PCA and Roles Anywhere (Recommended for Production)**

This option combines automated certificate management (PCA) with secure certificate-based authentication (Roles Anywhere).

1. Add to your `.env` file:
   ```shell
   # Commercial Bridge PCA configuration
   ENABLE_PCA="true"
   ENABLE_ROLES_ANYWHERE="true"
   ROLES_ANYWHERE_CA_TYPE="PCA"  # Use PCA for certificate authority
   PCA_CA_COMMON_NAME="Commercial Bridge Root CA"  # Optional
   PCA_CA_ORGANIZATION="Innovation Sandbox"        # Optional

   # GovCloud Secrets Manager configuration
   GOVCLOUD_SECRET_NAME="/InnovationSandbox/CommercialBridge/ClientCert"
   GOVCLOUD_REGION="us-gov-east-1"
   CERT_VALIDITY_DAYS="365"
   AWS_GOVCLOUD_PROFILE="govcloud"  # Your GovCloud profile name
   ```

2. Deploy Commercial Bridge (includes both PCA and RolesAnywhere stacks):
   ```shell
   npm run commercial:deploy
   ```
   RolesAnywhere will automatically use the PCA as its trust anchor.

3. Issue client certificates and store in GovCloud:
   ```shell
   npm run commercial:pca:issue-and-update-secret
   ```

   This performs the complete certificate lifecycle:
   - Issues certificate from PCA in commercial account
   - Saves locally to `commercial-bridge/certs/`
   - Creates/updates GovCloud Secrets Manager secret with certificate
   - Certificate is valid for 365 days (configurable via CERT_VALIDITY_DAYS)

4. Extract Commercial Bridge outputs for GovCloud configuration:
   ```shell
   # Get Trust Anchor ARN
   aws cloudformation describe-stacks --stack-name CommercialBridge-RolesAnywhere \
     --query 'Stacks[0].Outputs[?OutputKey==`TrustAnchorArn`].OutputValue' --output text \
     --profile commercial

   # Get Profile ARN
   aws cloudformation describe-stacks --stack-name CommercialBridge-RolesAnywhere \
     --query 'Stacks[0].Outputs[?OutputKey==`ProfileArn`].OutputValue' --output text \
     --profile commercial

   # Get Role ARN
   aws cloudformation describe-stacks --stack-name CommercialBridge-RolesAnywhere \
     --query 'Stacks[0].Outputs[?OutputKey==`RoleArn`].OutputValue' --output text \
     --profile commercial
   ```

5. Add these ARNs to your `.env` for GovCloud stack deployment:
   ```shell
   COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN="<secret-arn-from-step-3>"
   COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN="<trust-anchor-arn>"
   COMMERCIAL_BRIDGE_PROFILE_ARN="<profile-arn>"
   COMMERCIAL_BRIDGE_ROLE_ARN="<role-arn>"
   ```

6. Now deploy GovCloud stacks - they'll use certificate-based authentication to call Commercial Bridge APIs.

#### Using AWS Profiles

Commands automatically use `AWS_COMMERCIAL_PROFILE` from `.env`, or specify explicitly:

```shell
npm run commercial:bootstrap -- --profile commercial
npm run commercial:deploy -- --profile commercial
npm run commercial:pca:issue-and-update-secret -- --profile commercial
npm run commercial:destroy -- --profile commercial
```

#### Cleanup

```shell
# Destroy all commercial bridge stacks (including optional stacks if deployed)
npm run commercial:destroy
```

### Configuration

The Commercial Bridge uses the following environment variables from `.env`:

**Core Configuration:**
- `ENABLE_PCA` - Set to "true" to deploy AWS Private CA (~$400/month)
- `PCA_CA_COMMON_NAME` - Common Name for the CA certificate (default: "Commercial Bridge Root CA")
- `PCA_CA_ORGANIZATION` - Organization name for the CA (default: "Innovation Sandbox")
- `ENABLE_ROLES_ANYWHERE` - Set to "true" to enable IAM Roles Anywhere

**Certificate Generation (Required if using PCA + Roles Anywhere):**
- `GOVCLOUD_SECRET_NAME` - Secrets Manager secret name in GovCloud (default: "/InnovationSandbox/CommercialBridge/ClientCert")
- `GOVCLOUD_REGION` - GovCloud region for Secrets Manager (default: "us-gov-east-1")
- `CERT_VALIDITY_DAYS` - Certificate validity period in days (default: "365")
- `AWS_GOVCLOUD_PROFILE` - AWS CLI profile for GovCloud account access

**Auto-populated During Deployment:**
- `COMMERCIAL_BRIDGE_API_URL` - API Gateway endpoint URL (from stack outputs)
- `COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN` - Secrets Manager secret ARN (after certificate issuance)
- `COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN` - IAM Roles Anywhere trust anchor ARN (from stack outputs)
- `COMMERCIAL_BRIDGE_PROFILE_ARN` - IAM Roles Anywhere profile ARN (from stack outputs)
- `COMMERCIAL_BRIDGE_ROLE_ARN` - IAM role ARN for Roles Anywhere (from stack outputs)

**Important Notes:**
- Certificate issuance requires **both commercial and GovCloud credentials**
  - Commercial credentials: To access PCA and issue certificates
  - GovCloud credentials: To store certificates in Secrets Manager
- The `pca:issue-and-update-secret` script automatically handles cross-partition credential switching
- Certificates must be rotated before expiration (default: 1 year)

### Complete Manual Setup Example (PCA + Roles Anywhere)

Here's a complete step-by-step example for manually setting up PCA and Roles Anywhere:

```shell
# Step 1: Configure .env for Commercial Bridge with PCA and Roles Anywhere
cat >> .env << 'EOF'
# Commercial Bridge Configuration
AWS_COMMERCIAL_PROFILE="commercial"
AWS_GOVCLOUD_PROFILE="govcloud"
ENABLE_PCA="true"
ENABLE_ROLES_ANYWHERE="true"
ROLES_ANYWHERE_CA_TYPE="PCA"  # Use PCA for certificates
GOVCLOUD_REGION="us-gov-east-1"
GOVCLOUD_SECRET_NAME="/InnovationSandbox/CommercialBridge/ClientCert"
EOF

# Step 2: Deploy Commercial Bridge to commercial account
npm run commercial:install
npm run commercial:bootstrap -- --profile commercial
npm run commercial:deploy -- --profile commercial
# Deploys: CostInfo, AccountCreation, AcceptInvitation, ApiGateway, PCA, RolesAnywhere

# Step 3: Issue client certificate and store in GovCloud
npm run commercial:pca:issue-and-update-secret
# Requires: OpenSSL, commercial profile for PCA, govcloud profile for Secrets Manager
# Creates: commercial-bridge/certs/govcloud-commercial-bridge.{pem,key,chain}
# Updates: GovCloud Secrets Manager secret with base64-encoded cert and key

# Step 4: Extract Commercial Bridge ARNs
aws cloudformation describe-stacks --stack-name CommercialBridge-ApiGateway \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text \
  --profile commercial > /tmp/api-url.txt

aws cloudformation describe-stacks --stack-name CommercialBridge-RolesAnywhere \
  --query 'Stacks[0].Outputs' --output json --profile commercial > /tmp/roles-anywhere-outputs.json

# Step 5: Add extracted values to .env
# COMMERCIAL_BRIDGE_API_URL="<from api-url.txt>"
# COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN="<from roles-anywhere-outputs.json>"
# COMMERCIAL_BRIDGE_PROFILE_ARN="<from roles-anywhere-outputs.json>"
# COMMERCIAL_BRIDGE_ROLE_ARN="<from roles-anywhere-outputs.json>"
# COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN="<from pca:issue-and-update-secret output>"

# Step 6: Deploy GovCloud stacks (they'll use cert-based auth to call Commercial Bridge)
npm run deploy:account-pool -- --profile govcloud
npm run deploy:idc -- --profile govcloud
npm run deploy:data -- --profile govcloud
npm run deploy:container -- --profile govcloud
```

**Troubleshooting:**
- **"OpenSSL not found"**: Install OpenSSL (included with Git for Windows, or install separately)
- **"Access denied" for GovCloud Secrets Manager**: Verify `AWS_GOVCLOUD_PROFILE` is configured correctly
- **"PcaStack not found"**: Ensure `ENABLE_PCA=true` before deploying commercial bridge
- **Certificate expired**: Rotate certificates using the same `pca:issue-and-update-secret` command (updates existing secret)

For more details, see [commercial-bridge/README.md](commercial-bridge/README.md).

## Uninstalling the Solution

### For Commercial Deployments

To uninstall the solution, run the following command from the repository root:

```shell
npm run destroy:all
```

If you had used a multi-account deployment or only want to destroy certain stacks you can use the following commands:

```shell
npm run destroy:compute  # For standard CloudFront deployment
# OR
npm run destroy:container  # For GovCloud/ECS deployment

npm run destroy:data
npm run destroy:idc
npm run destroy:account-pool
```

> **Note:** Only destroy either the compute stack OR the container stack, not both. Destroy in reverse order of deployment.

### For GovCloud Deployments

For GovCloud deployments, destroy both the GovCloud and Commercial Bridge stacks:

**Step 1: Destroy GovCloud Stacks**
```shell
npm run destroy:all
```

**Step 2: Destroy Commercial Bridge (Commercial Account)**
```shell
npm run commercial:destroy
```

This destroys all Commercial Bridge stacks:
- `CommercialBridge-RolesAnywhere` (if deployed)
- `CommercialBridge-PCA` (if deployed)
- `CommercialBridge-ApiGateway`
- `CommercialBridge-AcceptInvitation`
- `CommercialBridge-AccountCreation`
- `CommercialBridge-CostInfo`

## Cost Scaling

This solution incurs cost for both the solution infrastructure and any activity that occurs within the sandbox accounts. Cost will vary greatly based on sandbox account usage.

For more details on solution infrastructure cost estimation see the [implementation guide](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/cost.html).

## File Structure

```
root
├── commercial-bridge/              # CDK app for GovCloud deployments (deployed to commercial AWS account)
│   ├── infrastructure                  # CDK stacks for Commercial Bridge API
│   ├── lambdas                         # Lambda functions for cost reporting and account creation
│   └── scripts                         # Certificate generation scripts for IAM Roles Anywhere
├── deployment/                     # shell scripts to generate native cloudformation distributables
│   ├── global-s3-assets                # generated dist files for cdk synthesized cloudformation templates
│   ├── regional-s3-assets              # generated dist files for zipped runtime assets such as lambda functions
│   └── build-s3-dist.sh                # builds solution into distributable assets that can be deployed with cloudformation
├── docs/                           # documentation and architecture diagrams
├── scripts/                        # scripts used to run checks and configuration on the repository
│   └── configure.cjs                   # interactive configuration wizard
├── source/                         # source code separated into multiple stand alone packages
│   ├── common                          # common libraries used across the solution
│   ├── e2e                             # e2e test suite
│   ├── frontend                        # frontend vite application
│   ├── infrastructure                  # cdk application consisting of solution infrastructure
│   ├── lambdas                         # lambda function runtime code, contains multiple lambdas each of which is its own package
│   └── layers                          # lambda layers, contains multiple layers each of which is its own package
├── .env.example                    # template for environment variables
├── .gitleaks.toml                  # GitLeaks secret scanner configuration
├── .pre-commit-config.yaml         # pre-commit hook configurations
├── .secretsignore                  # secret scanner ignore patterns (TruffleHog, detect-secrets, etc.)
└── package.json                    # top level npm package.json file with scripts to serve as orchestrated monorepo commands
```

## Pre-Commit

This repository uses pre-commit. Pre-commit is a framework for managing and maintaining multi-language pre-commit hooks which are scripts that run every time you make a commit. This offers automated checks with quick feedback cycles that enable code reviewers to focus on architecture and design rather than syntax and style.

To install the hooks, run the following commands:

```shell
# this installs the pre-commit package manager
pip install pre-commit
```

```shell
# this will install the hook scripts contained in the .pre-commit-config.yaml file
pre-commit install
```

Once installed pre-commit hooks will be ran on each commit preventing commits that do not pass the configured checks. Certain hooks will automatically alter and reformat code so that you don't have to.

If you would like to run the hooks without making a commit, run the following command.

```shell
pre-commit run --all-files
```

For more information on pre-commit, refer to the official documentation [here](https://pre-commit.com/).

## Security Considerations

### Secret Scanning Configuration

The repository includes configuration files to prevent false positives from secret scanning tools:

- **`.gitleaks.toml`** - Configuration for GitLeaks scanner
  - Excludes test files (`*.test.ts`, `__snapshots__/`)
  - Ignores test fixtures with `TEST-*`, `MOCK-*` prefixes
  - Allows placeholder values (example.com, 000000000000)

- **`.secretsignore`** - Pattern-based ignore file for multiple scanners
  - Compatible with TruffleHog, detect-secrets, and other tools
  - Excludes test files, documentation, build artifacts

**Test files use clearly marked mock values:**
- Test tokens: `TEST-TOKEN-00000000-0000-0000-0000-000000000000`
- Mock passwords: `MOCK-PASSWORD-FOR-TESTING-ONLY-1234`
- Inline ignore comments: `// gitleaks:allow` for specific lines

If your organization uses a different secret scanner, you may need to add similar configuration or ignore patterns.

### Command Injection Prevention

The repository includes validation to prevent command injection vulnerabilities:

**`scripts/run-with-env.cjs`:**
- Uses `shell: true` (required for npm scripts with shell operators like `&&`, `||`, pipes)
- Includes validation for dangerous command patterns (rm -rf /, curl | sh, etc.)
- Commands originate from trusted `package.json` npm scripts, not user input
- Environment variables from `.env` should be treated as trusted deployment configuration

**`commercial-bridge/scripts/issue-client-cert-from-pca.ts`:**
- Sanitizes `commonName` input to prevent injection in OpenSSL commands
- Only allows alphanumeric characters, hyphens, underscores, and dots
- Validates length constraints (1-64 characters)

**`source/infrastructure/lib/components/lambda-layers.ts`:**
- Validates directory paths to ensure no shell metacharacters
- Paths come from hardcoded `__dirname` + relative paths (build-time only)
- Defense-in-depth validation even though paths are not user-controlled

### .env File Security

The `.env` file contains deployment configuration and should be secured:
- **Never commit** `.env` to version control (use `.env.example` as template)
- Restrict file permissions: `chmod 600 .env` on Unix systems
- Treat as sensitive: Contains account IDs, regions, and deployment settings
- In CI/CD: Use encrypted secrets or parameter stores instead of .env files

## Collection of Operational Metrics

This solution collects anonymous operational metrics to help AWS improve the quality and features of the solution. For more information, including how to disable this capability, please see the [implementation guide](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/reference.html#anonymized-data-collection).

## License

Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Apache License Version 2.0 (the "License"). You may not use this file except
in compliance with the License. A copy of the License is located at http://www.apache.org/licenses/
or in the "[LICENSE](./LICENSE)" file accompanying this file. This file is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. See the License for the
specific language governing permissions and limitations under the License.

## Contact Information

For questions or feedback about this solution, please contact:

- AWS Solutions: [aws-solutions@amazon.com](mailto:aws-solutions@amazon.com)
- GitHub Issues: Submit questions or issues through the [GitHub repository issues page](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues)

## Additional Resources

- [AWS Solutions Library](https://aws.amazon.com/solutions/)
- [AWS CloudFormation Documentation](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/Welcome.html)
- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
- [AWS Account Management](https://docs.aws.amazon.com/accounts/latest/reference/accounts-welcome.html)
- [AWS Nuke Repository](https://github.com/ekristen/aws-nuke)
