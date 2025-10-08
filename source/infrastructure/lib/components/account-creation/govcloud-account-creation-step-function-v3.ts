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

interface GovCloudAccountCreationStepFunctionV3Props {
  initiateCreationLambda: Function;
  checkStatusLambda: Function;
  sendInvitationLambda: Function;
  acceptInvitationLambda: Function;
  moveToEntryOULambda: Function;
  registerInISBLambda: Function;
}

export class GovCloudAccountCreationStepFunctionV3 extends Construct {
  public readonly stateMachine: StateMachine;

  constructor(
    scope: Construct,
    id: string,
    props: GovCloudAccountCreationStepFunctionV3Props,
  ) {
    super(scope, id);

    // ===== JOIN FLOW STATES (shared by both modes) =====

    const prepareJoinInput = new Pass(this, "PrepareJoinInput", {
      parameters: {
        "govCloudAccountId.$": "$.govCloudAccountId",
        "commercialAccountId.$": "$.commercialAccountId",
        "accountName.$": "$.accountName",
      },
    });

    const sendInvitation = new LambdaInvoke(this, "SendOrganizationInvitation", {
      lambdaFunction: props.sendInvitationLambda,
      payload: TaskInput.fromObject({
        govCloudAccountId: JsonPath.stringAt("$.govCloudAccountId"),
        commercialAccountId: JsonPath.stringAt("$.commercialAccountId"),
        accountName: JsonPath.stringAt("$.accountName"),
      }),
      resultPath: "$.invitation",
    });

    const extractInvitationResult = new Pass(this, "ExtractInvitationResult", {
      parameters: {
        "govCloudAccountId.$": "$.invitation.Payload.govCloudAccountId",
        "commercialAccountId.$": "$.invitation.Payload.commercialAccountId",
        "handshakeId.$": "$.invitation.Payload.handshakeId",
        "accountName.$": "$.invitation.Payload.accountName",
      },
    });

    const acceptInvitation = new LambdaInvoke(this, "AcceptInvitation", {
      lambdaFunction: props.acceptInvitationLambda,
      payload: TaskInput.fromObject({
        govCloudAccountId: JsonPath.stringAt("$.govCloudAccountId"),
        commercialAccountId: JsonPath.stringAt("$.commercialAccountId"),
        handshakeId: JsonPath.stringAt("$.handshakeId"),
        accountName: JsonPath.stringAt("$.accountName"),
      }),
      resultPath: "$.accept",
    });

    const extractAcceptResult = new Pass(this, "ExtractAcceptResult", {
      parameters: {
        "govCloudAccountId.$": "$.accept.Payload.govCloudAccountId",
        "commercialAccountId.$": "$.accept.Payload.commercialAccountId",
        "accountName.$": "$.accept.Payload.accountName",
      },
    });

    const moveToEntryOU = new LambdaInvoke(this, "MoveToEntryOU", {
      lambdaFunction: props.moveToEntryOULambda,
      payload: TaskInput.fromObject({
        govCloudAccountId: JsonPath.stringAt("$.govCloudAccountId"),
        commercialAccountId: JsonPath.stringAt("$.commercialAccountId"),
        accountName: JsonPath.stringAt("$.accountName"),
      }),
      resultPath: "$.move",
    });

    const extractMoveResult = new Pass(this, "ExtractMoveResult", {
      parameters: {
        "govCloudAccountId.$": "$.move.Payload.govCloudAccountId",
        "commercialAccountId.$": "$.move.Payload.commercialAccountId",
        "accountName.$": "$.move.Payload.accountName",
      },
    });

    const waitForStackSets = new Wait(this, "WaitForStackSets", {
      time: WaitTime.duration(Duration.minutes(2)),
    });

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

    // Chain join flow
    const joinFlowChain = Chain.start(prepareJoinInput)
      .next(sendInvitation)
      .next(extractInvitationResult)
      .next(acceptInvitation)
      .next(extractAcceptResult)
      .next(moveToEntryOU)
      .next(extractMoveResult)
      .next(waitForStackSets)
      .next(registerInISB)
      .next(addMetadata);

    // ===== CREATE FLOW STATES =====

    const initiateCreation = new LambdaInvoke(this, "InitiateAccountCreation", {
      lambdaFunction: props.initiateCreationLambda,
      payload: TaskInput.fromObject({
        accountName: JsonPath.stringAt("$.accountName"),
        email: JsonPath.stringAt("$.email"),
      }),
      resultPath: "$.creation",
    });

    const extractCreationResult = new Pass(this, "ExtractCreationResult", {
      parameters: {
        "requestId.$": "$.creation.Payload.requestId",
        "accountName.$": "$.creation.Payload.accountName",
        "email.$": "$.creation.Payload.email",
        "mode.$": "$.mode",
      },
    });

    const waitForCreation = new Wait(this, "WaitForCreationStatus", {
      time: WaitTime.duration(Duration.seconds(5)),
    });

    const checkStatus = new LambdaInvoke(this, "CheckAccountStatus", {
      lambdaFunction: props.checkStatusLambda,
      payload: TaskInput.fromObject({
        requestId: JsonPath.stringAt("$.requestId"),
        accountName: JsonPath.stringAt("$.accountName"),
        email: JsonPath.stringAt("$.email"),
      }),
      resultPath: "$.statusCheck",
    });

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

    const accountCreationFailed = new Fail(this, "AccountCreationFailed", {
      error: "AccountCreationFailed",
      causePath: "$.message",
    });

    const accountReadyChoice = new Choice(this, "AccountCreationComplete?")
      .when(Condition.stringEquals("$.status", "SUCCEEDED"), joinFlowChain)
      .when(Condition.stringEquals("$.status", "FAILED"), accountCreationFailed)
      .otherwise(waitForCreation);

    // Chain waitForCreation to loop back
    waitForCreation.next(checkStatus);
    checkStatus.next(extractStatusResult);
    extractStatusResult.next(accountReadyChoice);

    const createFlowChain = Chain.start(initiateCreation)
      .next(extractCreationResult)
      .next(waitForCreation);

    // ===== MODE CHOICE =====

    const invalidMode = new Fail(this, "InvalidMode", {
      error: "InvalidMode",
      cause: "Mode must be 'create' or 'join-existing'",
    });

    const modeChoice = new Choice(this, "CreateOrJoinExisting?")
      .when(Condition.stringEquals("$.mode", "create"), createFlowChain)
      .when(Condition.stringEquals("$.mode", "join-existing"), joinFlowChain)
      .otherwise(invalidMode);

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
}
