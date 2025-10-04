// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ECS Frontend Deployment
 *
 * This construct deploys the Innovation Sandbox frontend as an ECS service.
 * It is designed as an alternative to CloudFront + S3 for regions where CloudFront is not available (e.g., GovCloud).
 *
 * Architecture:
 * - Application Load Balancer (ALB) for HTTPS termination
 * - ECS Fargate service running NGINX containers
 * - Private ECR repository for frontend Docker images
 * - Auto-scaling based on CPU/memory utilization
 */

import { Duration } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface EcsFrontendProps {
  readonly namespace: string;
  readonly vpc: ec2.IVpc;
  readonly privateEcrFrontendRepo?: string;
  readonly privateEcrRepoRegion?: string;
  readonly restApiUrl: string;
  readonly cluster: ecs.ICluster;
  readonly allowedCidr?: string; // Single CIDR for simplicity with CloudFormation parameters
}

export class EcsFrontend extends Construct {
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: EcsFrontendProps) {
    super(scope, id);

    if (!props.privateEcrFrontendRepo) {
      throw new Error(
        "Private ECR repository is required for ECS frontend deployment. " +
        "Please specify PRIVATE_ECR_FRONTEND_REPO in your configuration."
      );
    }

    // Create CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/aws/ecs/${props.namespace}-frontend`,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // Create Application Load Balancer
    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: props.vpc,
      description: "Security group for frontend ALB",
      allowAllOutbound: true,
    });

    // Allow HTTP/HTTPS from specified CIDR or anywhere
    // Note: We use CfnSecurityGroupIngress to support CloudFormation token CIDRs
    const allowedCidr = props.allowedCidr || "0.0.0.0/0";

    new ec2.CfnSecurityGroupIngress(this, "HttpIngress", {
      groupId: albSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 80,
      toPort: 80,
      cidrIp: allowedCidr,
      description: "Allow HTTP traffic",
    });

    new ec2.CfnSecurityGroupIngress(this, "HttpsIngress", {
      groupId: albSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      cidrIp: allowedCidr,
      description: "Allow HTTPS traffic",
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    // Create ECS Task Definition
    this.taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
      memoryLimitMiB: 512,
      cpu: 256,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
    });

    // Get container image from private ECR
    const repository = ecr.Repository.fromRepositoryName(
      this,
      "PrivateEcrRepo",
      props.privateEcrFrontendRepo
    );
    const containerImage = ecs.ContainerImage.fromEcrRepository(repository, "latest");

    // Add container to task definition
    const container = this.taskDefinition.addContainer("FrontendContainer", {
      image: containerImage,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "frontend",
        logGroup: logGroup,
      }),
      environment: {
        VITE_API_URL: props.restApiUrl,
        NAMESPACE: props.namespace,
      },
      portMappings: [
        {
          containerPort: 80,
          protocol: ecs.Protocol.TCP,
        },
      ],
      healthCheck: {
        command: ["CMD-SHELL", "wget --quiet --tries=1 --spider http://localhost:80/health || exit 1"],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
    });

    // Create security group for ECS service
    const serviceSecurityGroup = new ec2.SecurityGroup(this, "ServiceSecurityGroup", {
      vpc: props.vpc,
      description: "Security group for frontend ECS service",
      allowAllOutbound: true,
    });

    serviceSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(80),
      "Allow traffic from ALB"
    );

    // Create ECS Service
    this.service = new ecs.FargateService(this, "Service", {
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 2, // Run 2 tasks for high availability
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [serviceSecurityGroup],
      enableExecuteCommand: true,
      healthCheckGracePeriod: Duration.seconds(60),
    });

    // Add target group and listener
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc: props.vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        path: "/health",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(30),
    });

    // Add HTTP listener (can be upgraded to HTTPS with ACM certificate)
    this.loadBalancer.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    // Enable auto-scaling
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 10,
    });

    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 70,
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60),
    });

    scaling.scaleOnMemoryUtilization("MemoryScaling", {
      targetUtilizationPercent: 80,
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60),
    });
  }
}
