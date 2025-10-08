// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Chain,
  DefinitionBody,
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

interface GovCloudAccountCreationStepFunctionProps {
  createAccountLambda: Function;
}

export class GovCloudAccountCreationStepFunction extends Construct {
  public readonly stateMachine: StateMachine;

  constructor(
    scope: Construct,
    id: string,
    props: GovCloudAccountCreationStepFunctionProps,
  ) {
    super(scope, id);

    // Lambda task to create and join account
    const createAndJoinAccountTask = new LambdaInvoke(
      this,
      "CreateAndJoinGovCloudAccount",
      {
        lambdaFunction: props.createAccountLambda,
        payload: TaskInput.fromObject({
          accountName: JsonPath.stringAt("$.accountName"),
          email: JsonPath.stringAt("$.email"),
        }),
        resultPath: JsonPath.stringAt("$.result"),
      },
    );

    const addMetadata = new Pass(this, "AddMetadata", {
      parameters: {
        "executionId.$": "$$.Execution.Id",
        "executionArn.$": "$$.Execution.Id",
        "startTime.$": "$$.Execution.StartTime",
        "input.$": "$$.Execution.Input",
        "result.$": "$.result.Payload",
      },
    });

    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(
        Chain.start(createAndJoinAccountTask).next(addMetadata),
      ),
      timeout: Duration.minutes(35), // Account creation can take up to 30 minutes
      logs: {
        level: LogLevel.ALL,
        destination: IsbComputeResources.globalLogGroup,
      },
      tracingEnabled: true,
    });
  }
}
