// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Networking shared by the ALB + S3 hosting mode: a VPC with the S3 and
 * execute-api interface endpoints. Created before the RestApi so the API can be
 * made PRIVATE with a resource policy scoped to the execute-api endpoint, and
 * shared with AlbS3UiApi so it does not create duplicate networking.
 *
 * Only instantiated when hostingMode=alb-s3.
 */
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export interface IsbPrivateNetworkProps {
  namespace: string;
}

export class IsbPrivateNetwork extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly s3Endpoint: ec2.InterfaceVpcEndpoint;
  public readonly executeApiEndpoint: ec2.InterfaceVpcEndpoint;

  constructor(scope: Construct, id: string, _props: IsbPrivateNetworkProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0, // no internet egress — all traffic stays in-VPC
      subnetConfiguration: [
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    this.s3Endpoint = this.vpc.addInterfaceEndpoint("S3Endpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.S3,
      privateDnsEnabled: false,
    });

    this.executeApiEndpoint = this.vpc.addInterfaceEndpoint(
      "ExecuteApiEndpoint",
      {
        service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
        privateDnsEnabled: true,
      },
    );
  }
}
