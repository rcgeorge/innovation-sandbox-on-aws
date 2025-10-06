// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export class CostInfoLambdaStack extends cdk.Stack {
  public readonly lambdaFunction: lambda.IFunction;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create Lambda function for cost information
    this.lambdaFunction = new nodejs.NodejsFunction(this, 'CostInfoFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambdas/cost-information/src/handler.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
      },
    });

    // Grant Cost Explorer permissions
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ce:GetCostAndUsage',
          'ce:GetCostForecast',
          'ce:GetDimensionValues',
          'ce:GetTags',
        ],
        resources: ['*'],
      })
    );

    // CloudFormation outputs
    new cdk.CfnOutput(this, 'CostInfoLambdaArn', {
      value: this.lambdaFunction.functionArn,
      description: 'ARN of Cost Information Lambda function',
      exportName: 'CostInfoLambdaArn',
    });
  }
}

export class CreateGovCloudAccountLambdaStack extends cdk.Stack {
  public readonly lambdaFunction: lambda.IFunction;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create Lambda function for GovCloud account creation
    this.lambdaFunction = new nodejs.NodejsFunction(this, 'CreateGovCloudAccountFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambdas/create-govcloud-account/src/handler.ts'),
      timeout: cdk.Duration.minutes(2), // Needs more time for polling
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
      },
    });

    // Grant Organizations permissions
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'organizations:CreateGovCloudAccount',
          'organizations:DescribeCreateAccountStatus',
          'organizations:ListAccounts',
          'organizations:DescribeAccount',
        ],
        resources: ['*'],
      })
    );

    // CloudFormation outputs
    new cdk.CfnOutput(this, 'CreateGovCloudAccountLambdaArn', {
      value: this.lambdaFunction.functionArn,
      description: 'ARN of Create GovCloud Account Lambda function',
      exportName: 'CreateGovCloudAccountLambdaArn',
    });
  }
}
