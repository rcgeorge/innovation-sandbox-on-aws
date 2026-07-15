// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * GovCloud cross-partition account provisioning. Only instantiated when
 * enableGovCloudAccountProvisioning is set (and hence commercial-bridge config
 * is present). Follows the ISB event → EventBridge Rule → Step Function
 * pattern (same as CleanAccountRequest → Account Cleaner).
 *
 * The state machine drives the orchestrator Lambda action-by-action:
 *   create → (poll checkStatus until SUCCEEDED/FAILED) → sendInvitation →
 *   acceptInvitation → moveToEntry. Once in the Entry OU the account enters the
 *   normal ISB onboarding lifecycle.
 */
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { SfnStateMachine } from "aws-cdk-lib/aws-events-targets";
import { Role } from "aws-cdk-lib/aws-iam";
import {
  Choice,
  Condition,
  DefinitionBody,
  Fail,
  LogLevel,
  Pass,
  StateMachine,
  Succeed,
  TaskInput,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Duration } from "aws-cdk-lib";
import { Construct } from "constructs";

import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { GovCloudProvisioningLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/govcloud-provisioning-lambda-environment.js";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  commercialBridgeEnv,
  grantCommercialBridgeAccess,
} from "@amzn/innovation-sandbox-infrastructure/helpers/commercial-bridge-config";
import {
  getOrgMgtRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import path from "path";

export interface GovCloudProvisioningProps {
  eventBus: EventBus;
  namespace: string;
  orgMgtAccountId: string;
  /** GovCloud home region whose Organizations service issues/accepts invites. */
  govCloudHomeRegion: string;
}

export class GovCloudProvisioning extends Construct {
  constructor(scope: Construct, id: string, props: GovCloudProvisioningProps) {
    super(scope, id);

    const orchestrator = new IsbLambdaFunction(this, "Orchestrator", {
      description:
        "Orchestrates cross-partition GovCloud account provisioning steps",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "account-management",
        "govcloud-provisioning",
        "src",
        "govcloud-provisioning-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      timeout: Duration.seconds(60),
      environment: {
        ISB_NAMESPACE: props.namespace,
        ACCOUNT_TABLE_NAME: IsbComputeStack.sharedSpokeConfig.data.accountTable,
        ACCOUNT_POOL_CONFIG_PARAM_ARN:
          IsbComputeStack.sharedSpokeConfig.parameterArns
            .accountPoolConfigParamArn,
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
          scope,
          props.namespace,
          props.orgMgtAccountId,
        ),
        GOVCLOUD_HOME_REGION: props.govCloudHomeRegion,
        ...commercialBridgeEnv(scope),
      },
      logGroup: IsbComputeResources.globalLogGroup,
      envSchema: GovCloudProvisioningLambdaEnvironmentSchema,
    });

    IntermediateRole.addTrustedRole(orchestrator.lambdaFunction.role! as Role);
    grantIsbDbReadWrite(
      scope,
      orchestrator,
      IsbComputeStack.sharedSpokeConfig.data.accountTable,
    );
    grantIsbSsmParameterRead(
      orchestrator.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );
    grantCommercialBridgeAccess(scope, orchestrator.lambdaFunction);

    const invoke = (id2: string, action: string, extra: object = {}) =>
      new LambdaInvoke(this, id2, {
        lambdaFunction: orchestrator.lambdaFunction,
        payload: TaskInput.fromObject({ action, ...extra }),
        resultSelector: { "payload.$": "$.Payload" },
        resultPath: "$.lastResult",
      });

    const provisioningFailed = new Fail(this, "ProvisioningFailed", {
      error: "GovCloudProvisioningFailed",
    });

    const create = invoke("InitiateAccountCreation", "create", {
      "accountName.$": "$.detail.accountName",
      "email.$": "$.detail.email",
    });

    const waitForCreation = new Wait(this, "WaitForCreation", {
      time: WaitTime.duration(Duration.seconds(30)),
    });

    const checkStatus = invoke("CheckAccountStatus", "checkStatus", {
      "requestId.$": "$.lastResult.payload.requestId",
    });

    const sendInvitation = invoke("SendOrganizationInvitation", "sendInvitation", {
      "govCloudAccountId.$": "$.lastResult.payload.govCloudAccountId",
    });

    // sendInvitation overwrites lastResult; stash creation ids first.
    const stashCreation = new Pass(this, "StashCreationResult", {
      parameters: {
        "govCloudAccountId.$": "$.lastResult.payload.govCloudAccountId",
        "commercialAccountId.$": "$.lastResult.payload.commercialAccountId",
      },
      resultPath: "$.created",
    });

    const acceptInvitation = invoke("AcceptInvitation", "acceptInvitation", {
      "govCloudAccountId.$": "$.created.govCloudAccountId",
      "commercialAccountId.$": "$.created.commercialAccountId",
      "handshakeId.$": "$.lastResult.payload.handshakeId",
    });

    const moveToEntry = invoke("MoveToEntryOU", "moveToEntry", {
      "govCloudAccountId.$": "$.created.govCloudAccountId",
      "commercialAccountId.$": "$.created.commercialAccountId",
    });

    const succeed = new Succeed(this, "ProvisioningComplete");

    const statusChoice = new Choice(this, "AccountCreated?")
      .when(
        Condition.stringEquals("$.lastResult.payload.status", "SUCCEEDED"),
        stashCreation
          .next(sendInvitation)
          .next(acceptInvitation)
          .next(moveToEntry)
          .next(succeed),
      )
      .when(
        Condition.stringEquals("$.lastResult.payload.status", "FAILED"),
        provisioningFailed,
      )
      .otherwise(waitForCreation);

    waitForCreation.next(checkStatus);
    checkStatus.next(statusChoice);

    const definition = create.next(waitForCreation);

    const stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(definition),
      timeout: Duration.hours(1),
      logs: {
        level: LogLevel.ALL,
        destination: IsbComputeResources.globalLogGroup,
      },
      tracingEnabled: true,
    });

    new Rule(this, "GovCloudProvisioningRule", {
      eventBus: props.eventBus,
      description: "Triggers GovCloud account provisioning on request",
      eventPattern: {
        detailType: [EventDetailTypes.GovCloudAccountProvisioningRequest],
      },
      targets: [new SfnStateMachine(stateMachine)],
    });
  }
}
