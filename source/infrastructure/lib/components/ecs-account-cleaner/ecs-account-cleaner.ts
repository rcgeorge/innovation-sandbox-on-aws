// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ECS Account Cleaner Service
 *
 * This construct deploys the account cleaner as an ECS Fargate service.
 * It provides an alternative to the CodeBuild-based account cleaner for scenarios
 * where running cleanup tasks in a containerized environment is preferred.
 *
 * Features:
 * - Runs AWS Nuke in an ECS Fargate container
 * - Triggered by EventBridge or Step Functions
 * - Uses private ECR repository for the container image
 * - CloudWatch logging for audit and debugging
 */

import { RemovalPolicy } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface EcsAccountCleanerProps {
  readonly namespace: string;
  readonly vpc: ec2.IVpc;
  readonly ecrRepository: ecr.IRepository; // ECR repository (created by stack)
  readonly privateEcrRepo?: string; // For compatibility
  readonly privateEcrRepoRegion?: string; // For compatibility
  readonly cluster: ecs.ICluster;
}

export class EcsAccountCleaner extends Construct {
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: EcsAccountCleanerProps) {
    super(scope, id);

    // Create CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/aws/ecs/${props.namespace}-account-cleaner`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Create ECS Task Definition
    this.taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
      memoryLimitMiB: 4096,
      cpu: 2048,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
    });

    // Grant permissions for account cleanup
    this.taskDefinition.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("PowerUserAccess")
    );

    // Add IAM permissions for assuming roles in sandbox accounts
    this.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: ["*"], // Will be scoped to sandbox account roles
      })
    );

    // Get container image from ECR repository (created by Container stack)
    const containerImage = ecs.ContainerImage.fromEcrRepository(props.ecrRepository, "latest");

    // Add container to task definition
    this.taskDefinition.addContainer("AccountCleanerContainer", {
      image: containerImage,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "account-cleaner",
        logGroup: logGroup,
      }),
      environment: {
        NAMESPACE: props.namespace,
      },
      // Account cleaner typically runs as a task, not a long-running service
      // We'll use this for one-off cleanup jobs
      essential: true,
    });

    // Create ECS Service (optional - can also be invoked as one-off tasks)
    // Note: This creates a service that runs 0 tasks by default
    // Tasks will be started on-demand by Step Functions or EventBridge
    this.service = new ecs.FargateService(this, "Service", {
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 0, // Start with 0, tasks will be run on-demand
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      enableExecuteCommand: true, // Enable ECS Exec for debugging
    });
  }
}
