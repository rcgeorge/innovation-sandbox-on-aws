# Innovation Sandbox on AWS

## Solution Overview

The Innovation Sandbox on AWS solution allows cloud administrators to set up and recycle temporary sandbox environments by automating
the implementation of security and governance policies,spend management mechanisms, and account recycling preferences through a web user interface (UI).
Using the solution, customers can empower their teams to experiment, learn, and innovate with AWS services in production-isolated AWS accounts that are recycled after use.

To find out more about Innovation Sandbox on AWS visit our [AWS Solutions](https://aws.amazon.com/solutions/implementations/innovation-sandbox-on-aws)
page.

## Quick Start

For the fastest path to deployment:

1. **Install dependencies**: `npm install`
2. **Run configuration wizard**: `npm run configure`
   - Auto-detects your AWS environment
   - Guides you through all required settings
   - Optionally deploys all stacks in correct order
3. **Access your deployment**: Get CloudFront or ALB URL from stack outputs

The wizard handles everything including Commercial Bridge deployment for GovCloud regions.

## Table of Contents

- [Innovation Sandbox on AWS](#innovation-sandbox-on-aws)
  - [Solution Overview](#solution-overview)
  - [Quick Start](#quick-start)
  - [Table of Contents](#table-of-contents)
  - [Architecture](#architecture)
  - [Prerequisites](#prerequisites)
  - [Environment Variables](#environment-variables)
  - [Deploy the Solution](#deploy-the-solution)
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
- Python (Optional)
- Pre-Commit (Optional)
- Docker (Optional)

> **Note for Windows Users:** The solution now supports Windows development environments. All npm scripts have been updated to work cross-platform. The bash scripts in the `deployment/` folder are still Linux/MacOS only, but core development and deployment commands work on Windows.

Once your development environment meets the minimum requirements install the necessary dependencies, navigate to the root of the repository and run:

```shell
npm install
```

> **Note:** Many of the commands in this file expect you to have appropriate AWS CLI access to the target accounts configured. If you have a multi-account deployment you will need to switch between account credentials to perform the commands on the appropriate accounts.

## Environment Variables

Before you start working from the Innovation Sandbox on AWS repository you must first configure your environment. You have two options:

### Option 1: Interactive Configuration Wizard (Recommended)

Use the interactive wizard to be prompted for all required values:

```shell
npm run configure
```

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

### Deployment Prerequisites

The solution requires several prerequisite steps before attempting to deploy the solution. See the [implementation guide](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/prerequisites.html) for more details.

### Deploy from the AWS Console

| Stack        |                                                                                                          CloudFormation Launch Link                                                                                                           |                                                         S3 Download Link                                                         |
| ------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------: |
| Account Pool | [Launch](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?&templateURL=https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-AccountPool.template&redirectId=GitHub) | [Download](https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-AccountPool.template) |
| IDC          |     [Launch](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?&templateURL=https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-IDC.template&redirectId=GitHub)     |     [Download](https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-IDC.template)     |
| Data         |    [Launch](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?&templateURL=https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-Data.template&redirectId=GitHub)     |    [Download](https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-Data.template)     |
| Compute      |   [Launch](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?&templateURL=https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-Compute.template&redirectId=GitHub)   |   [Download](https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-Compute.template)   |

### Deploy from Source

Deploying the solution from source uses AWS CDK to do so. If you have not already you will need to bootstrap the target accounts with the following command:

```shell
npm run bootstrap
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

**For GovCloud Deployments:**

GovCloud deployments require additional infrastructure in a commercial AWS account to access commercial-only APIs (Cost Explorer, Organizations CreateGovCloudAccount). Follow this deployment order:

**Step 1: Deploy Commercial Bridge (Commercial AWS Account)**

```shell
npm run commercial:install
npm run commercial:bootstrap
npm run commercial:deploy
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

```shell
npm run deploy:account-pool
npm run deploy:idc
npm run deploy:data
npm run deploy:container
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
- Build Docker images
- Push images to your private ECR repositories

The wizard will prompt for:
1. **Account Cleaner ECR** - For hosting the AWS Nuke container (CodeBuild)
2. **Frontend ECR** (Optional) - For hosting the frontend container (future ECS deployment)

When prompted, answer yes and follow the prompts. The wizard will handle everything automatically if you have Docker running.

### Option 2: Manual Setup

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

**Deploy Changes:**

If you have already deployed the solution, redeploy the compute stack to use the private ECR repos:
```shell
npm run deploy:compute
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

From the repository root:

```shell
# Install dependencies
npm run commercial:install

# Bootstrap CDK (one-time setup)
npm run commercial:bootstrap

# Deploy all commercial bridge stacks
npm run commercial:deploy

# Issue client certificates (if using PCA)
npm run commercial:pca:issue-and-update-secret

# Destroy all commercial bridge stacks
npm run commercial:destroy
```

### Configuration

The Commercial Bridge uses the following environment variables from `.env`:

**Core Configuration:**
- `ENABLE_PCA` - Set to "true" to deploy AWS Private CA (~$400/month)
- `PCA_CA_COMMON_NAME` - Common Name for the CA certificate (default: "Commercial Bridge Root CA")
- `PCA_CA_ORGANIZATION` - Organization name for the CA (default: "Innovation Sandbox")
- `ENABLE_ROLES_ANYWHERE` - Set to "true" to enable IAM Roles Anywhere

**Auto-populated During Deployment:**
- `COMMERCIAL_BRIDGE_API_URL` - API Gateway endpoint URL (extracted from stack outputs)

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
├── .pre-commit-config.yaml         # pre-commit hook configurations
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
