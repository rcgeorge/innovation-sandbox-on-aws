// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK construct for creating CodeBuild projects that build and push Docker images to ECR.
 * This enables container image builds without requiring Docker to be installed locally.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface DockerBuildProjectProps {
  /**
   * Name of the CodeBuild project
   */
  readonly projectName: string;

  /**
   * Description of what this build project does
   */
  readonly description: string;

  /**
   * Source code configuration for the build
   */
  readonly source: codebuild.ISource;

  /**
   * ECR repository where the Docker image will be pushed
   */
  readonly ecrRepository: ecr.IRepository;

  /**
   * Docker image tag (default: 'latest')
   */
  readonly imageTag?: string;

  /**
   * Path to the buildspec file relative to source root
   * @default 'buildspec.yml'
   */
  readonly buildspecPath?: string;

  /**
   * Additional environment variables to pass to the build
   */
  readonly environmentVariables?: { [key: string]: codebuild.BuildEnvironmentVariable };

  /**
   * Log retention in days
   * @default logs.RetentionDays.ONE_MONTH
   */
  readonly logRetention?: logs.RetentionDays;
}

/**
 * Creates a CodeBuild project configured to build Docker images and push to ECR.
 *
 * This construct:
 * - Creates a CodeBuild project with Docker build capabilities
 * - Configures ECR authentication and push permissions
 * - Sets up CloudWatch Logs with configurable retention
 * - Provides environment variables for Docker image tagging
 *
 * @example
 * ```typescript
 * const buildProject = new DockerBuildProject(this, 'NukeBuild', {
 *   projectName: 'innovation-sandbox-nuke-build',
 *   description: 'Builds AWS Nuke container image',
 *   source: codebuild.Source.gitHub({
 *     owner: 'aws-solutions',
 *     repo: 'innovation-sandbox',
 *   }),
 *   ecrRepository: nukeRepository,
 * });
 * ```
 */
export class DockerBuildProject extends Construct {
  /**
   * The CodeBuild project
   */
  public readonly project: codebuild.Project;

  /**
   * CloudWatch Log Group for build logs
   */
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: DockerBuildProjectProps) {
    super(scope, id);

    const imageTag = props.imageTag ?? 'latest';
    const buildspecPath = props.buildspecPath ?? 'buildspec.yml';

    // Create CloudWatch Log Group for build logs
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/codebuild/${props.projectName}`,
      retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Extract ECR registry URL (everything before the repository name)
    const ecrRegistryUrl = props.ecrRepository.repositoryUri.split('/')[0];

    // Create CodeBuild project
    this.project = new codebuild.Project(this, 'Project', {
      projectName: props.projectName,
      description: props.description,
      source: props.source,

      // Use standard Linux build image with Docker support
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // Required for Docker daemon
        computeType: codebuild.ComputeType.SMALL,
      },

      // Load buildspec from source
      buildSpec: codebuild.BuildSpec.fromSourceFilename(buildspecPath),

      // Configure environment variables for Docker build
      environmentVariables: {
        AWS_DEFAULT_REGION: {
          value: props.ecrRepository.env.region,
        },
        ECR_REGISTRY: {
          value: ecrRegistryUrl,
        },
        IMAGE_REPO_NAME: {
          value: props.ecrRepository.repositoryName,
        },
        IMAGE_TAG: {
          value: imageTag,
        },
        ...props.environmentVariables,
      },

      // Send logs to CloudWatch
      logging: {
        cloudWatch: {
          logGroup: this.logGroup,
        },
      },

      // Set build timeout to 15 minutes
      timeout: Duration.minutes(15),
    });

    // Grant ECR permissions to CodeBuild
    this.grantEcrPermissions(props.ecrRepository);
  }

  /**
   * Grant necessary ECR permissions to the CodeBuild project
   */
  private grantEcrPermissions(repository: ecr.IRepository): void {
    // Grant push/pull permissions to the repository
    repository.grantPullPush(this.project);

    // Grant ECR auth token permissions (required for docker login)
    this.project.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );
  }

  /**
   * Get the ARN of the CodeBuild project
   */
  public get projectArn(): string {
    return this.project.projectArn;
  }

  /**
   * Get the name of the CodeBuild project
   */
  public get projectName(): string {
    return this.project.projectName;
  }
}
