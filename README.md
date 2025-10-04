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
  - IAM Identity Center instance information
  - AWS Organizations root ID
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

## Uninstalling the Solution

To uninstall the solution, run the following command from the repository root:

```shell
npm run destroy:all
```

If you had used a multi-account deployment or only want to destroy certain stacks you can use the following commands:

```shell
npm run destroy:account-pool
npm run destroy:idc
npm run destroy:data
npm run destroy:compute
```

## Cost Scaling

This solution incurs cost for both the solution infrastructure and any activity that occurs within the sandbox accounts. Cost will vary greatly based on sandbox account usage.

For more details on solution infrastructure cost estimation see the [implementation guide](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/cost.html).

## File Structure

```
root
├── deployment/                     # shell scripts to generate native cloudformation distributables
│   ├── global-s3-assets                # generated dist files for cdk synthesized cloudformation templates
│   ├── regional-s3-assets              # generated dist files for zipped runtime assets such as lambda functions
│   └── build-s3-dist.sh                # builds solution into distributable assets that can be deployed with cloudformation
├── docs/                           # shell scripts to generate native cloudformation distributables
├── scripts/                        # scripts used to run checks on the repository
├── source/                         # source code separated into multiple stand alone packages
│   ├── common                          # common libraries used across the solution
│   ├── e2e                             # e2e test suite
│   ├── frontend                        # frontend vite application
│   ├── infrastructure                  # cdk application consisting of solution infrastructure
│   ├── lambdas                         # lambda function runtime code, contains multiple lambdas each of which is its own package
│   └── layers                          # lambda layers, contains multiple layers each of which is its own package
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
