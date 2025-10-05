// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { EventBus } from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";
import path from "path";

import { AccountLifecycleManagementEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lifecycle-management-lambda-environment.js";
import { sharedIdcSsmParamName } from "@amzn/innovation-sandbox-commons/types/isb-types";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { EventsToSqsToLambda } from "@amzn/innovation-sandbox-infrastructure/components/events-to-sqs-to-lambda";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  getIdcRoleArn,
  getOrgMgtRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbAppConfigRead,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { AccountLifecycleManager } from "@amzn/innovation-sandbox-lambda/account-lifecycle-management/account-lifecycle-manager.js";
import { Duration } from "aws-cdk-lib";
import { Role } from "aws-cdk-lib/aws-iam";

export interface AccountLifeCycleLambdaProps {
  isbEventBus: EventBus;
  namespace: string;
  orgManagementAccountId: string;
  idcAccountId: string;
  isGovCloud?: boolean;
}

export class AccountLifecycleManagementLambda extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: AccountLifeCycleLambdaProps,
  ) {
    super(scope, id);

    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
      accountTable,
      leaseTable,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const { sandboxOuId } = IsbComputeStack.sharedSpokeConfig.accountPool;

    const lambda = new IsbLambdaFunction(this, id, {
      description:
        "responds to lease events and determines what further actions should be taken",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "account-management",
        "account-lifecycle-management",
        "src",
        "account-lifecycle-manager.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      environment: {
        APP_CONFIG_APPLICATION_ID: configApplicationId,
        APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
        APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
        AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId}`,
        ISB_EVENT_BUS: props.isbEventBus.eventBusName,
        ISB_NAMESPACE: props.namespace,
        ACCOUNT_TABLE_NAME: accountTable,
        SANDBOX_OU_ID: sandboxOuId,
        LEASE_TABLE_NAME: leaseTable,
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
          scope,
          props.namespace,
          props.orgManagementAccountId,
        ),
        IDC_ROLE_ARN: getIdcRoleArn(scope, props.namespace, props.idcAccountId),
      },
      logGroup: IsbComputeResources.globalLogGroup,
      envSchema: AccountLifecycleManagementEnvironmentSchema,
      reservedConcurrentExecutions: 1,
    });

    grantIsbSsmParameterRead(
      lambda.lambdaFunction.role! as Role,
      sharedIdcSsmParamName(props.namespace),
      props.idcAccountId,
    );
    grantIsbDbReadWrite(scope, lambda, leaseTable, accountTable);
    grantIsbAppConfigRead(scope, lambda, globalConfigConfigurationProfileId);
    addAppConfigExtensionLayer(lambda);
    props.isbEventBus.grantPutEventsTo(lambda.lambdaFunction);
    IntermediateRole.addTrustedRole(lambda.lambdaFunction.role! as Role);

    new EventsToSqsToLambda(scope, "AccountLifeCycleEventsToSqsToLambda", {
      namespace: props.namespace,
      eventBus: props.isbEventBus,
      lambdaFunction: lambda.lambdaFunction,
      isGovCloud: props.isGovCloud,
      sqsQueueProps: {
        maxEventAge: Duration.hours(4),
        retryAttempts: 3,
      },
      ruleProps: {
        eventBus: props.isbEventBus,
        description: "Triggers account life cycle manager lambda via SQS",
        enabled: true,
        eventPattern: {
          detailType: AccountLifecycleManager.trackedLeaseEvents,
        },
      },
    });
  }
}
