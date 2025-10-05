// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Container Stack for Innovation Sandbox on AWS
 *
 * This stack deploys containerized services using Amazon ECS Fargate:
 * - Account Cleaner: Runs AWS Nuke in a container for account cleanup
 * - Frontend (Optional): Serves the web UI via ECS instead of CloudFront (for regions like GovCloud)
 *
 * Architecture:
 * - VPC with public and private subnets
 * - Application Load Balancer (ALB) for HTTPS
 * - ECS Fargate cluster
 * - ECR repositories for container images
 * - CloudWatch logs for monitoring
 */

import { CfnCondition, CfnOutput, Fn, Stack, StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import { Construct } from "constructs";

import { EcsAccountCleaner } from "@amzn/innovation-sandbox-infrastructure/components/ecs-account-cleaner/ecs-account-cleaner";
import { EcsFrontend } from "@amzn/innovation-sandbox-infrastructure/components/ecs-frontend/ecs-frontend";
import { ParameterWithLabel } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import { NamespaceParam } from "@amzn/innovation-sandbox-infrastructure/helpers/namespace-param";
import { applyIsbTag } from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";

export class IsbContainerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Namespace parameter (required for all stacks)
    const namespaceParam = new NamespaceParam(this);

    // ECR Configuration Parameters
    const privateEcrRepo = new ParameterWithLabel(this, "PrivateEcrRepo", {
      label: "Private ECR Repository for Account Cleaner",
      description: "The name of the private ECR repository containing the account cleaner image",
      default: "",
    });

    const privateEcrRepoRegion = new ParameterWithLabel(this, "PrivateEcrRepoRegion", {
      label: "Private ECR Repository Region",
      description: "The AWS region where the private ECR repositories are located",
      default: "us-east-1",
      allowedPattern: "^[a-z]{2}(-gov)?(-[a-z]+-\\d{1})$",
    });

    const privateEcrFrontendRepo = new ParameterWithLabel(this, "PrivateEcrFrontendRepo", {
      label: "Private ECR Repository for Frontend (Optional)",
      description: "The name of the private ECR repository containing the frontend image. Leave empty to skip frontend deployment.",
      default: "",
    });

    // VPC Configuration Parameters
    const vpcCidr = new ParameterWithLabel(this, "VpcCidr", {
      label: "VPC CIDR Block",
      description: "The CIDR block for the VPC",
      default: "10.0.0.0/16",
      allowedPattern: "^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])(\\/(1[6-9]|2[0-8]))$",
    });

    const allowListedCidr = new ParameterWithLabel(this, "AllowListedIPRanges", {
      label: "Allow Listed IP Range",
      description: "CIDR block allowed to access the frontend ALB",
      default: "0.0.0.0/0",
      allowedPattern: "^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])(\\/([0-9]|[1-2][0-9]|3[0-2]))$",
    });

    const restApiUrl = new ParameterWithLabel(this, "RestApiUrl", {
      label: "REST API URL",
      description: "The URL of the backend REST API (from Compute stack)",
      default: "",
    });

    const certificateArn = new ParameterWithLabel(this, "CertificateArn", {
      label: "ACM Certificate ARN (Optional)",
      description: "ARN of ACM certificate for HTTPS on the ALB. Leave empty for HTTP only.",
      default: "",
    });

    // Apply tagging
    applyIsbTag(this, namespaceParam.namespace.valueAsString);

    // Create VPC with public and private subnets
    // Note: We use a fixed CIDR here because CDK cannot auto-subdivide parameter tokens
    // The actual CIDR is controlled by the vpcCidr parameter at deploy time
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // Override the VPC CIDR with the parameter value
    const cfnVpc = vpc.node.defaultChild as ec2.CfnVPC;
    cfnVpc.cidrBlock = vpcCidr.valueAsString;

    // Create ECS Cluster
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: vpc,
      clusterName: `${namespaceParam.namespace.valueAsString}-cluster`,
      containerInsights: true,
    });

    // Conditionally create frontend based on whether ECR repo is provided
    const deployFrontendCondition = new CfnCondition(this, "DeployFrontendCondition", {
      expression: Fn.conditionNot(Fn.conditionEquals(privateEcrFrontendRepo.valueAsString, "")),
    });

    // Deploy Account Cleaner ECS Service
    let accountCleaner: EcsAccountCleaner | undefined;
    if (privateEcrRepo.valueAsString) {
      accountCleaner = new EcsAccountCleaner(this, "AccountCleaner", {
        namespace: namespaceParam.namespace.valueAsString,
        vpc: vpc,
        cluster: cluster,
        privateEcrRepo: privateEcrRepo.valueAsString,
        privateEcrRepoRegion: privateEcrRepoRegion.valueAsString,
      });
    }

    // Deploy Frontend ECS Service (conditional)
    let frontend: EcsFrontend | undefined;
    if (privateEcrFrontendRepo.valueAsString && restApiUrl.valueAsString) {
      frontend = new EcsFrontend(this, "Frontend", {
        namespace: namespaceParam.namespace.valueAsString,
        vpc: vpc,
        cluster: cluster,
        privateEcrFrontendRepo: privateEcrFrontendRepo.valueAsString,
        privateEcrRepoRegion: privateEcrRepoRegion.valueAsString,
        restApiUrl: restApiUrl.valueAsString,
        allowedCidr: allowListedCidr.valueAsString,
        certificateArn: certificateArn.valueAsString,
      });

      // Output the frontend URL (HTTPS if certificate provided, otherwise HTTP)
      const protocol = certificateArn.valueAsString && certificateArn.valueAsString.trim() !== "" ? "https" : "http";
      new CfnOutput(this, "FrontendUrl", {
        value: `${protocol}://${frontend.loadBalancer.loadBalancerDnsName}`,
        description: "Frontend Application URL",
        exportName: `${namespaceParam.namespace.valueAsString}-FrontendUrl`,
      });
    }

    // Outputs
    new CfnOutput(this, "ClusterName", {
      value: cluster.clusterName,
      description: "ECS Cluster Name",
      exportName: `${namespaceParam.namespace.valueAsString}-ClusterName`,
    });

    new CfnOutput(this, "VpcId", {
      value: vpc.vpcId,
      description: "VPC ID",
      exportName: `${namespaceParam.namespace.valueAsString}-VpcId`,
    });
  }
}
