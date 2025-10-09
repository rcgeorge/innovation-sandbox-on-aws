// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CodeBuild Stack for Innovation Sandbox on AWS
 *
 * This optional stack deploys CodeBuild projects that build and push container images to ECR.
 * It provides an alternative to local Docker builds for users who:
 * - Don't have Docker installed or running
 * - Want consistent build environments
 * - Need to build images in CI/CD pipelines
 * - Are working on systems where Docker is not available (e.g., some Windows environments)
 *
 * Architecture:
 * - Two CodeBuild projects: one for AWS Nuke container, one for frontend container
 * - Projects pull source from GitHub (or can be triggered with local source)
 * - Images are built using Docker and pushed to specified ECR repositories
 * - CloudWatch Logs for build monitoring
 *
 * Prerequisites:
 * - ECR repositories must exist (same ones used by Container/Compute stacks)
 * - Source code available in GitHub or as local zip
 */

import { CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Construct } from "constructs";

import { DockerBuildProject } from "@amzn/innovation-sandbox-infrastructure/components/codebuild/docker-build-project";
import { ParameterWithLabel } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import { NamespaceParam } from "@amzn/innovation-sandbox-infrastructure/helpers/namespace-param";
import { applyIsbTag } from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";

export class IsbCodeBuildStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id);

    // Namespace parameter (required for all stacks)
    const namespaceParam = new NamespaceParam(this);

    // ECR Configuration Parameters
    const privateEcrRepo = new ParameterWithLabel(this, "PrivateEcrRepo", {
      label: "Private ECR Repository for Account Cleaner",
      description:
        "The name of the private ECR repository where the AWS Nuke image will be pushed",
      default: "innovation-sandbox-nuke",
    });

    const privateEcrRepoRegion = new ParameterWithLabel(
      this,
      "PrivateEcrRepoRegion",
      {
        label: "Private ECR Repository Region",
        description: "The AWS region where the ECR repositories are located",
        default: "us-east-1",
      }
    );

    const privateEcrFrontendRepo = new ParameterWithLabel(
      this,
      "PrivateEcrFrontendRepo",
      {
        label: "Private ECR Repository for Frontend",
        description:
          "The name of the private ECR repository where the frontend image will be pushed",
        default: "innovation-sandbox-frontend",
      }
    );

    // GitHub source configuration (optional)
    const gitHubOwner = new ParameterWithLabel(this, "GitHubOwner", {
      label: "GitHub Repository Owner (Optional)",
      description:
        "GitHub organization or username. Leave empty to use local source uploads.",
      default: "",
    });

    const gitHubRepo = new ParameterWithLabel(this, "GitHubRepo", {
      label: "GitHub Repository Name (Optional)",
      description:
        "GitHub repository name. Leave empty to use local source uploads.",
      default: "",
    });

    const gitHubBranch = new ParameterWithLabel(this, "GitHubBranch", {
      label: "GitHub Branch (Optional)",
      description: "Branch to build from when using GitHub source",
      default: "main",
    });

    // Apply tagging
    applyIsbTag(this, namespaceParam.namespace.valueAsString);

    // Reference existing ECR repositories
    const nukeRepository = ecr.Repository.fromRepositoryAttributes(
      this,
      "NukeRepository",
      {
        repositoryName: privateEcrRepo.valueAsString,
        repositoryArn: Stack.of(this).formatArn({
          service: "ecr",
          resource: "repository",
          resourceName: privateEcrRepo.valueAsString,
          region: privateEcrRepoRegion.valueAsString,
        }),
      }
    );

    const frontendRepository = ecr.Repository.fromRepositoryAttributes(
      this,
      "FrontendRepository",
      {
        repositoryName: privateEcrFrontendRepo.valueAsString,
        repositoryArn: Stack.of(this).formatArn({
          service: "ecr",
          resource: "repository",
          resourceName: privateEcrFrontendRepo.valueAsString,
          region: privateEcrRepoRegion.valueAsString,
        }),
      }
    );

    // Use NO_SOURCE configuration by default
    // This means source code must be provided when triggering builds via the trigger script
    // Users can modify this stack to use GitHub source if they have a repository
    const nukeSource = codebuild.Source.gitHub({
      owner: "awslabs",
      repo: "innovation-sandbox-on-aws",
      branchOrRef: "main",
    });

    const frontendSource = nukeSource; // Same source for both

    // Create CodeBuild project for AWS Nuke container
    const nukeCodeBuild = new DockerBuildProject(this, "NukeCodeBuild", {
      projectName: `${namespaceParam.namespace.valueAsString}-nuke-build`,
      description:
        "Builds and pushes the AWS Nuke container image to ECR without requiring local Docker",
      source: nukeSource,
      ecrRepository: nukeRepository,
      buildspecPath:
        "source/infrastructure/lib/components/account-cleaner/buildspec.yml",
      environmentVariables: {
        BUILDSPEC_OVERRIDE: {
          value:
            "source/infrastructure/lib/components/account-cleaner/buildspec.yml",
        },
      },
    });

    // Create CodeBuild project for frontend container
    const frontendCodeBuild = new DockerBuildProject(this, "FrontendCodeBuild", {
      projectName: `${namespaceParam.namespace.valueAsString}-frontend-build`,
      description:
        "Builds and pushes the frontend container image to ECR without requiring local Docker",
      source: frontendSource,
      ecrRepository: frontendRepository,
      buildspecPath: "source/frontend/buildspec.yml",
    });

    // Outputs for easy access to project names
    new CfnOutput(this, "NukeCodeBuildProjectName", {
      value: nukeCodeBuild.projectName,
      description: "CodeBuild project name for AWS Nuke container builds",
      exportName: `${this.stackName}-NukeCodeBuildProject`,
    });

    new CfnOutput(this, "FrontendCodeBuildProjectName", {
      value: frontendCodeBuild.projectName,
      description: "CodeBuild project name for frontend container builds",
      exportName: `${this.stackName}-FrontendCodeBuildProject`,
    });

    new CfnOutput(this, "NukeCodeBuildProjectArn", {
      value: nukeCodeBuild.projectArn,
      description: "ARN of the Nuke CodeBuild project",
    });

    new CfnOutput(this, "FrontendCodeBuildProjectArn", {
      value: frontendCodeBuild.projectArn,
      description: "ARN of the Frontend CodeBuild project",
    });

    // Output console URLs for monitoring builds
    new CfnOutput(this, "NukeCodeBuildConsoleUrl", {
      value: `https://console.aws.amazon.com/codesuite/codebuild/projects/${nukeCodeBuild.projectName}/history?region=${this.region}`,
      description: "AWS Console URL to monitor Nuke builds",
    });

    new CfnOutput(this, "FrontendCodeBuildConsoleUrl", {
      value: `https://console.aws.amazon.com/codesuite/codebuild/projects/${frontendCodeBuild.projectName}/history?region=${this.region}`,
      description: "AWS Console URL to monitor Frontend builds",
    });
  }
}
