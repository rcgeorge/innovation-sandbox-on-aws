// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { EventBus } from "aws-cdk-lib/aws-events";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Construct } from "constructs";
import path from "path";

import { LeaseMonitoringEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-monitoring-environment.js";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  commercialBridgeAccountEnv,
  commercialBridgeEnv,
  grantCommercialBridgeAccess,
} from "@amzn/innovation-sandbox-infrastructure/helpers/commercial-bridge-config";
import { isCommercialBridgeEnabled } from "@amzn/innovation-sandbox-infrastructure/helpers/govcloud-mode";
import {
  IntermediateRole,
  getOrgMgtRoleArn,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbDbReadOnly,
  grantIsbDbReadWrite,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export interface LeaseMonitoringLambdaProps {
  isbEventBus: EventBus;
  readonly namespace: string;
  orgMgtAccountId: string;
}

export class LeaseMonitoringLambda extends Construct {
  constructor(scope: Construct, id: string, props: LeaseMonitoringLambdaProps) {
    super(scope, id);

    const lambda = new IsbLambdaFunction(this, id, {
      description:
        "Scans active leases periodically to trigger events when alerts or actions need to be taken",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "account-management",
        "lease-monitoring",
        "src",
        "lease-monitoring-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      environment: {
        ISB_EVENT_BUS: props.isbEventBus.eventBusName,
        LEASE_TABLE_NAME: IsbComputeStack.sharedSpokeConfig.data.leaseTable,
        ISB_NAMESPACE: props.namespace,
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
          scope,
          props.namespace,
          props.orgMgtAccountId,
        ),
        // Account table + commercial bridge config only in GovCloud (bridge
        // mode); absent in commercial so its template is unchanged.
        ...commercialBridgeAccountEnv(
          scope,
          IsbComputeStack.sharedSpokeConfig.data.accountTable,
        ),
        ...commercialBridgeEnv(scope),
      },
      logGroup: IsbComputeResources.globalLogGroup,
      envSchema: LeaseMonitoringEnvironmentSchema,
      reservedConcurrentExecutions: 1,
    });

    props.isbEventBus.grantPutEventsTo(lambda.lambdaFunction);

    const role = new Role(scope, "LambdaInvokeRole", {
      description:
        "allows EventBridgeScheduler to invoke Innovation Sandbox's LeaseMonitoring lambda",
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
    });

    lambda.lambdaFunction.grantInvoke(role);
    IntermediateRole.addTrustedRole(lambda.lambdaFunction.role! as Role);
    grantIsbDbReadWrite(
      scope,
      lambda,
      IsbComputeStack.sharedSpokeConfig.data.leaseTable,
    );
    // The unified cost service reads the account table to map GovCloud
    // accounts to their commercial linked account — only needed in bridge mode.
    if (isCommercialBridgeEnabled(scope)) {
      grantIsbDbReadOnly(
        scope,
        lambda,
        IsbComputeStack.sharedSpokeConfig.data.accountTable,
      );
    }
    grantCommercialBridgeAccess(scope, lambda.lambdaFunction);

    new CfnSchedule(scope, "LeaseMonitoringScheduledEvent", {
      description: "triggers LeaseMonitoring every hour",
      scheduleExpression: "rate(1 hour)",
      flexibleTimeWindow: {
        mode: "FLEXIBLE",
        maximumWindowInMinutes: 5,
      },
      target: {
        retryPolicy: {
          maximumRetryAttempts: 20,
        },
        arn: lambda.lambdaFunction.functionArn,
        roleArn: role.roleArn,
      },
    });
  }
}
