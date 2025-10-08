// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Chain,
  Choice,
  Condition,
  DefinitionBody,
  Fail,
  JsonPath,
  LogLevel,
  Pass,
  StateMachine,
  TaskInput,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  LambdaInvoke,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Duration } from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { Function } from "aws-cdk-lib/aws-lambda";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";

interface GovCloudAccountCreationStepFunctionV2Props {
  initiateCreationLambda: Function;
  checkStatusLambda: Function;
  sendInvitationLambda: Function;
  acceptInvitationLambda: Function;
  moveToEntryOULambda: Function;
  registerInISBLambda: Function;
}

export class GovCloudAccountCreationStepFunctionV2 extends Construct {
  public readonly stateMachine: StateMachine;

  constructor(
    scope: Construct,
    id: string,
    props: GovCloudAccountCreationStepFunctionV2Props,
  ) {
    super(scope, id);

    // Build join flow first (shared by both paths)
    const joinFlowChain = this.buildJoinFlow(props);

    // Build create flow that leads into join flow
    const createFlowChain = this.buildCreateFlow(props, joinFlowChain);

    // Choice: Create new account or join existing?
    const modeChoice = new Choice(this, "CreateOrJoinExisting?")
      .when(
        Condition.stringEquals("$.mode", "create"),
        createFlowChain,
      )
      .when(
        Condition.stringEquals("$.mode", "join-existing"),
        joinFlowChain,
      )
      .otherwise(
        new Fail(this, "InvalidMode", {
          error: "InvalidMode",
          cause: "Mode must be 'create' or 'join-existing'",
        }),
      );

    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(modeChoice),
      timeout: Duration.minutes(40),
      logs: {
        level: LogLevel.ALL,
        destination: IsbComputeResources.globalLogGroup,
      },
      tracingEnabled: true,
    });
  }

  private buildCreateFlow(props: GovCloudAccountCreationStepFunctionV2Props, joinFlow: Chain): Chain {
    // Step 1: Initiate account creation
    const initiateCreation = new LambdaInvoke(this, "InitiateAccountCreation", {
      lambdaFunction: props.initiateCreationLambda,
      payload: TaskInput.fromObject({
        accountName: JsonPath.stringAt("$.accountName"),
        email: JsonPath.stringAt("$.email"),
      }),
      resultPath: "$.creation",
      outputPath: "$",
    });

    // Extract creation result to top level
    const extractCreationResult = new Pass(this, "ExtractCreationResult", {
      parameters: {
        "requestId.$": "$.creation.Payload.requestId",
        "accountName.$": "$.creation.Payload.accountName",
        "email.$": "$.creation.Payload.email",
        "mode.$": "$.mode",
      },
    });

    // Wait 5 seconds before checking status
    const waitForCreation = new Wait(this, "WaitForCreationStatus", {
      time: WaitTime.duration(Duration.seconds(5)),
    });

    // Step 2: Check account status
    const checkStatus = new LambdaInvoke(this, "CheckAccountStatus", {
      lambdaFunction: props.checkStatusLambda,
      payload: TaskInput.fromObject({
        requestId: JsonPath.stringAt("$.requestId"),
        accountName: JsonPath.stringAt("$.accountName"),
        email: JsonPath.stringAt("$.email"),
      }),
      resultPath: "$.statusCheck",
      outputPath: "$",
    });

    // Extract status result
    const extractStatusResult = new Pass(this, "ExtractStatusResult", {
      parameters: {
        "requestId.$": "$.requestId",
        "status.$": "$.statusCheck.Payload.status",
        "govCloudAccountId.$": "$.statusCheck.Payload.govCloudAccountId",
        "commercialAccountId.$": "$.statusCheck.Payload.commercialAccountId",
        "accountName.$": "$.statusCheck.Payload.accountName",
        "email.$": "$.statusCheck.Payload.email",
        "message.$": "$.statusCheck.Payload.message",
      },
    });

    // Choice: Is account ready?
    const accountReadyChoice = new Choice(this, "AccountCreationComplete?")
      .when(
        Condition.stringEquals("$.status", "SUCCEEDED"),
        joinFlow,
      )
      .when(
        Condition.stringEquals("$.status", "FAILED"),
        new Fail(this, "AccountCreationFailed", {
          error: "AccountCreationFailed",
          causePath: "$.message",
        }),
      )
      .otherwise(waitForCreation);  // Loop back if still IN_PROGRESS

    // Build create flow chain
    return Chain.start(initiateCreation)
      .next(extractCreationResult)
      .next(waitForCreation)
      .next(checkStatus)
      .next(extractStatusResult)
      .next(accountReadyChoice);
  }

  private buildJoinFlow(props: GovCloudAccountCreationStepFunctionV2Props): Chain {
    // Prepare input for join flow (works for both create and join-existing modes)
    const prepareJoinInput = new Pass(this, "PrepareJoinInput", {
      parameters: {
        "govCloudAccountId.$": "$.govCloudAccountId",
        "commercialAccountId.$": "$.commercialAccountId",
        "accountName.$": "$.accountName",
      },
    });

    // Step 3: Send organization invitation
    const sendInvitation = new LambdaInvoke(this, "SendOrganizationInvitation", {
      lambdaFunction: props.sendInvitationLambda,
      payload: TaskInput.fromObject({
        govCloudAccountId: JsonPath.stringAt("$.govCloudAccountId"),
        commercialAccountId: JsonPath.stringAt("$.commercialAccountId"),
        accountName: JsonPath.stringAt("$.accountName"),
      }),
      resultPath: "$.invitation",
      outputPath: "$",
    });

    const extractInvitationResult = new Pass(this, "ExtractInvitationResult", {
      parameters: {
        "govCloudAccountId.$": "$.invitation.Payload.govCloudAccountId",
        "commercialAccountId.$": "$.invitation.Payload.commercialAccountId",
        "handshakeId.$": "$.invitation.Payload.handshakeId",
        "accountName.$": "$.invitation.Payload.accountName",
      },
    });

    // Step 4: Accept invitation
    const acceptInvitation = new LambdaInvoke(this, "AcceptInvitation", {
      lambdaFunction: props.acceptInvitationLambda,
      payload: TaskInput.fromObject({
        govCloudAccountId: JsonPath.stringAt("$.govCloudAccountId"),
        commercialAccountId: JsonPath.stringAt("$.commercialAccountId"),
        handshakeId: JsonPath.stringAt("$.handshakeId"),
        accountName: JsonPath.stringAt("$.accountName"),
      }),
      resultPath: "$.accept",
      outputPath: "$",
    });

    const extractAcceptResult = new Pass(this, "ExtractAcceptResult", {
      parameters: {
        "govCloudAccountId.$": "$.accept.Payload.govCloudAccountId",
        "commercialAccountId.$": "$.accept.Payload.commercialAccountId",
        "accountName.$": "$.accept.Payload.accountName",
      },
    });

    // Step 5: Move to Entry OU
    const moveToEntryOU = new LambdaInvoke(this, "MoveToEntryOU", {
      lambdaFunction: props.moveToEntryOULambda,
      payload: TaskInput.fromObject({
        govCloudAccountId: JsonPath.stringAt("$.govCloudAccountId"),
        commercialAccountId: JsonPath.stringAt("$.commercialAccountId"),
        accountName: JsonPath.stringAt("$.accountName"),
      }),
      resultPath: "$.move",
      outputPath: "$",
    });

    const extractMoveResult = new Pass(this, "ExtractMoveResult", {
      parameters: {
        "govCloudAccountId.$": "$.move.Payload.govCloudAccountId",
        "commercialAccountId.$": "$.move.Payload.commercialAccountId",
        "accountName.$": "$.move.Payload.accountName",
      },
    });

    // Step 6: Wait for StackSets (2 minutes)
    const waitForStackSets = new Wait(this, "WaitForStackSets", {
      time: WaitTime.duration(Duration.minutes(2)),
    });

    // Step 7: Register in ISB
    const registerInISB = new LambdaInvoke(this, "RegisterInISB", {
      lambdaFunction: props.registerInISBLambda,
      payload: TaskInput.fromObject({
        govCloudAccountId: JsonPath.stringAt("$.govCloudAccountId"),
        commercialAccountId: JsonPath.stringAt("$.commercialAccountId"),
        accountName: JsonPath.stringAt("$.accountName"),
      }),
      resultPath: "$.result",
    });

    const addMetadata = new Pass(this, "AddMetadata", {
      parameters: {
        "executionId.$": "$$.Execution.Id",
        "executionArn.$": "$$.Execution.Id",
        "startTime.$": "$$.Execution.StartTime",
        "input.$": "$$.Execution.Input",
        "result.$": "$.result.Payload",
      },
    });

    // Build join flow chain
    return Chain.start(prepareJoinInput)
      .next(sendInvitation)
      .next(extractInvitationResult)
      .next(acceptInvitation)
      .next(extractAcceptResult)
      .next(moveToEntryOU)
      .next(extractMoveResult)
      .next(waitForStackSets)
      .next(registerInISB)
      .next(addMetadata);
  }
}
