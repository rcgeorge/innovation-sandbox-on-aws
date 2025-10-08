// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { AccountLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import { CreateGovCloudAccountEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/create-govcloud-account-environment.js";
import { CommercialBridgeEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/commercial-bridge-environment.js";
import { GovCloudOrgEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/govcloud-org-environment.js";
import { RegisterISBEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/register-isb-environment.js";
import { sharedIdcSsmParamName } from "@amzn/innovation-sandbox-commons/types/isb-types";
import {
  RestApi,
  RestApiProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { GovCloudAccountCreationStepFunctionV3 } from "@amzn/innovation-sandbox-infrastructure/components/account-creation/govcloud-account-creation-step-function-v3";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { LambdaLayers } from "@amzn/innovation-sandbox-infrastructure/components/lambda-layers";
import { addCorsOptions } from "@amzn/innovation-sandbox-infrastructure/helpers/add-cors-options";
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
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import * as cdk from "aws-cdk-lib";
import { Aws, Stack } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";

export class AccountsApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiProps) {
    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
      accountTable,
      leaseTable,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const { sandboxOuId } = IsbComputeStack.sharedSpokeConfig.accountPool;

    // Get commercial bridge configuration from CDK context (optional - GovCloud only)
    const commercialBridgeApiUrl = Stack.of(scope).node.tryGetContext("commercialBridgeApiUrl") as string | undefined;
    const commercialBridgeApiKeySecretArn = Stack.of(scope).node.tryGetContext("commercialBridgeApiKeySecretArn") as string | undefined;

    // Get IAM Roles Anywhere configuration from CDK context (optional)
    const clientCertSecretArn = Stack.of(scope).node.tryGetContext("commercialBridgeClientCertSecretArn") as string | undefined;
    const trustAnchorArn = Stack.of(scope).node.tryGetContext("commercialBridgeTrustAnchorArn") as string | undefined;
    const profileArn = Stack.of(scope).node.tryGetContext("commercialBridgeProfileArn") as string | undefined;
    const roleArn = Stack.of(scope).node.tryGetContext("commercialBridgeRoleArn") as string | undefined;

    // Determine if using IAM Roles Anywhere
    const useRolesAnywhere = !!(clientCertSecretArn && trustAnchorArn && profileArn && roleArn);

    // Get Lambda layers (needed for IAM Roles Anywhere helper)
    const lambdaLayers = LambdaLayers.get(scope);

    // Build accountsLambda environment with conditional IAM Roles Anywhere support
    const accountsLambdaEnv: Record<string, any> = {
      APP_CONFIG_APPLICATION_ID: configApplicationId,
      APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
      APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
      AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId}`,
      ACCOUNT_TABLE_NAME: accountTable,
      LEASE_TABLE_NAME: leaseTable,
      ISB_NAMESPACE: props.namespace,
      INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
      ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
        scope,
        props.namespace,
        props.orgMgtAccountId,
      ),
      IDC_ROLE_ARN: getIdcRoleArn(
        scope,
        props.namespace,
        props.idcAccountId,
      ),
      ISB_EVENT_BUS: props.isbEventBus.eventBusName,
      SANDBOX_OU_ID: sandboxOuId,
      ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
      IDC_ACCOUNT_ID: props.idcAccountId,
      HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
      COMMERCIAL_BRIDGE_API_URL: commercialBridgeApiUrl,
    };

    // Add authentication config based on mode
    if (useRolesAnywhere) {
      Object.assign(accountsLambdaEnv, {
        COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN: clientCertSecretArn!,
        COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN: trustAnchorArn!,
        COMMERCIAL_BRIDGE_PROFILE_ARN: profileArn!,
        COMMERCIAL_BRIDGE_ROLE_ARN: roleArn!,
      });
    } else if (commercialBridgeApiKeySecretArn) {
      accountsLambdaEnv.COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN = commercialBridgeApiKeySecretArn;
    }

    const accountsLambdaFunction = new IsbLambdaFunction(
      scope,
      "AccountsLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for account resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "accounts",
          "src",
          "accounts-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: accountsLambdaEnv,
        layers: useRolesAnywhere ? [lambdaLayers.rolesAnywhereHelperLayer] : undefined,
        logGroup: restApi.logGroup,
        envSchema: AccountLambdaEnvironmentSchema,
        timeout: cdk.Duration.minutes(5), // Increased for account creation flow
      },
    );

    grantIsbSsmParameterRead(
      accountsLambdaFunction.lambdaFunction.role! as Role,
      sharedIdcSsmParamName(props.namespace),
      props.idcAccountId,
    );
    grantIsbDbReadWrite(
      scope,
      accountsLambdaFunction,
      IsbComputeStack.sharedSpokeConfig.data.accountTable,
      IsbComputeStack.sharedSpokeConfig.data.leaseTable,
    );
    grantIsbAppConfigRead(
      scope,
      accountsLambdaFunction,
      globalConfigConfigurationProfileId,
    );
    addAppConfigExtensionLayer(accountsLambdaFunction);
    props.isbEventBus.grantPutEventsTo(accountsLambdaFunction.lambdaFunction);

    IntermediateRole.addTrustedRole(
      accountsLambdaFunction.lambdaFunction.role! as Role,
    );

    // Grant Secrets Manager permission for commercial bridge auth (GovCloud only)
    if (useRolesAnywhere && clientCertSecretArn) {
      accountsLambdaFunction.lambdaFunction.addToRolePolicy(
        new PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [clientCertSecretArn],
        }),
      );
    } else if (commercialBridgeApiKeySecretArn) {
      accountsLambdaFunction.lambdaFunction.addToRolePolicy(
        new PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [commercialBridgeApiKeySecretArn],
        }),
      );
    }

    // ========================================
    // GovCloud Account Creation - Step Lambdas with Least Privilege
    // ========================================

    // Lambda 1: Initiate Account Creation
    // Permissions: Secrets Manager (commercial bridge API key or client cert)
    const initiateCreationEnv: Record<string, string> = {
      COMMERCIAL_BRIDGE_API_URL: commercialBridgeApiUrl || "",
    };

    // Add authentication config based on mode
    if (useRolesAnywhere) {
      Object.assign(initiateCreationEnv, {
        COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN: clientCertSecretArn!,
        COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN: trustAnchorArn!,
        COMMERCIAL_BRIDGE_PROFILE_ARN: profileArn!,
        COMMERCIAL_BRIDGE_ROLE_ARN: roleArn!,
      });
    } else if (commercialBridgeApiKeySecretArn) {
      initiateCreationEnv.COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN = commercialBridgeApiKeySecretArn;
    }

    const initiateCreationLambda = new IsbLambdaFunction(
      scope,
      "InitiateCreationLambda",
      {
        description: "Initiates GovCloud account creation via commercial bridge",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "account-creation",
          "govcloud-steps",
          "src",
          "initiate-creation.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: initiateCreationEnv,
        layers: useRolesAnywhere ? [lambdaLayers.rolesAnywhereHelperLayer] : undefined,
        logGroup: restApi.logGroup,
        envSchema: CommercialBridgeEnvironmentSchema,
        timeout: cdk.Duration.seconds(30),
      },
    );

    // Grant Secrets Manager permissions based on auth mode
    if (useRolesAnywhere && clientCertSecretArn) {
      initiateCreationLambda.lambdaFunction.addToRolePolicy(
        new PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [clientCertSecretArn],
        }),
      );
    } else if (commercialBridgeApiKeySecretArn) {
      initiateCreationLambda.lambdaFunction.addToRolePolicy(
        new PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [commercialBridgeApiKeySecretArn],
        }),
      );
    }

    // Lambda 2: Check Account Status
    // Permissions: Secrets Manager (commercial bridge API key or client cert)
    const checkStatusEnv: Record<string, string> = {
      COMMERCIAL_BRIDGE_API_URL: commercialBridgeApiUrl || "",
    };

    // Add authentication config based on mode
    if (useRolesAnywhere) {
      Object.assign(checkStatusEnv, {
        COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN: clientCertSecretArn!,
        COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN: trustAnchorArn!,
        COMMERCIAL_BRIDGE_PROFILE_ARN: profileArn!,
        COMMERCIAL_BRIDGE_ROLE_ARN: roleArn!,
      });
    } else if (commercialBridgeApiKeySecretArn) {
      checkStatusEnv.COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN = commercialBridgeApiKeySecretArn;
    }

    const checkStatusLambda = new IsbLambdaFunction(
      scope,
      "CheckStatusLambda",
      {
        description: "Checks GovCloud account creation status",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "account-creation",
          "govcloud-steps",
          "src",
          "check-status.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: checkStatusEnv,
        layers: useRolesAnywhere ? [lambdaLayers.rolesAnywhereHelperLayer] : undefined,
        logGroup: restApi.logGroup,
        envSchema: CommercialBridgeEnvironmentSchema,
        timeout: cdk.Duration.seconds(30),
      },
    );

    // Grant Secrets Manager permissions based on auth mode
    if (useRolesAnywhere && clientCertSecretArn) {
      checkStatusLambda.lambdaFunction.addToRolePolicy(
        new PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [clientCertSecretArn],
        }),
      );
    } else if (commercialBridgeApiKeySecretArn) {
      checkStatusLambda.lambdaFunction.addToRolePolicy(
        new PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [commercialBridgeApiKeySecretArn],
        }),
      );
    }

    // Lambda 3: Send Organization Invitation
    // Permissions: STS AssumeRole (OrgMgt role), SSM Parameter Read
    const sendInvitationLambda = new IsbLambdaFunction(
      scope,
      "SendInvitationLambda",
      {
        description: "Sends organization invitation to GovCloud account",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "account-creation",
          "govcloud-steps",
          "src",
          "send-invitation.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: {
          ISB_NAMESPACE: props.namespace,
          SANDBOX_OU_ID: sandboxOuId,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            scope,
            props.namespace,
            props.orgMgtAccountId,
          ),
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          IDC_ACCOUNT_ID: props.idcAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
        },
        logGroup: restApi.logGroup,
        envSchema: GovCloudOrgEnvironmentSchema,
        timeout: cdk.Duration.seconds(60),
      },
    );

    grantIsbSsmParameterRead(
      sendInvitationLambda.lambdaFunction.role! as Role,
      sharedIdcSsmParamName(props.namespace),
      props.idcAccountId,
    );
    IntermediateRole.addTrustedRole(sendInvitationLambda.lambdaFunction.role! as Role);
    sendInvitationLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [getOrgMgtRoleArn(scope, props.namespace, props.orgMgtAccountId)],
      }),
    );

    // Lambda 4: Accept Invitation
    // Permissions: STS AssumeRole (OrgMgt role), SSM Parameter Read
    const acceptInvitationLambda = new IsbLambdaFunction(
      scope,
      "AcceptInvitationLambda",
      {
        description: "Accepts organization invitation",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "account-creation",
          "govcloud-steps",
          "src",
          "accept-invitation.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: {
          ISB_NAMESPACE: props.namespace,
          SANDBOX_OU_ID: sandboxOuId,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            scope,
            props.namespace,
            props.orgMgtAccountId,
          ),
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          IDC_ACCOUNT_ID: props.idcAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
        },
        logGroup: restApi.logGroup,
        envSchema: GovCloudOrgEnvironmentSchema,
        timeout: cdk.Duration.seconds(60),
      },
    );

    grantIsbSsmParameterRead(
      acceptInvitationLambda.lambdaFunction.role! as Role,
      sharedIdcSsmParamName(props.namespace),
      props.idcAccountId,
    );
    IntermediateRole.addTrustedRole(acceptInvitationLambda.lambdaFunction.role! as Role);
    acceptInvitationLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          getOrgMgtRoleArn(scope, props.namespace, props.orgMgtAccountId),
          // Allow assuming OrganizationAccountAccessRole in any account for accepting invitations
          Stack.of(scope).formatArn({
            service: "iam",
            region: "",
            account: "*",
            resource: "role",
            resourceName: "OrganizationAccountAccessRole",
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // Lambda 5: Move to Entry OU
    // Permissions: STS AssumeRole (OrgMgt role), SSM Parameter Read
    const moveToEntryOULambda = new IsbLambdaFunction(
      scope,
      "MoveToEntryOULambda",
      {
        description: "Moves account to Entry OU",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "account-creation",
          "govcloud-steps",
          "src",
          "move-to-entry-ou.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: {
          ISB_NAMESPACE: props.namespace,
          SANDBOX_OU_ID: sandboxOuId,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            scope,
            props.namespace,
            props.orgMgtAccountId,
          ),
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          IDC_ACCOUNT_ID: props.idcAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
        },
        logGroup: restApi.logGroup,
        envSchema: GovCloudOrgEnvironmentSchema,
        timeout: cdk.Duration.seconds(60),
      },
    );

    grantIsbSsmParameterRead(
      moveToEntryOULambda.lambdaFunction.role! as Role,
      sharedIdcSsmParamName(props.namespace),
      props.idcAccountId,
    );
    IntermediateRole.addTrustedRole(moveToEntryOULambda.lambdaFunction.role! as Role);
    moveToEntryOULambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [getOrgMgtRoleArn(scope, props.namespace, props.orgMgtAccountId)],
      }),
    );

    // Lambda 6: Register in ISB
    // Permissions: STS AssumeRole (OrgMgt + IDC roles), DynamoDB Write, EventBridge PutEvents, SSM Parameter Read
    const registerInISBLambda = new IsbLambdaFunction(
      scope,
      "RegisterInISBLambda",
      {
        description: "Registers account in Innovation Sandbox",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "account-creation",
          "govcloud-steps",
          "src",
          "register-in-isb.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: {
          ACCOUNT_TABLE_NAME: accountTable,
          ISB_NAMESPACE: props.namespace,
          ISB_EVENT_BUS: props.isbEventBus.eventBusName,
          SANDBOX_OU_ID: sandboxOuId,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            scope,
            props.namespace,
            props.orgMgtAccountId,
          ),
          IDC_ROLE_ARN: getIdcRoleArn(
            scope,
            props.namespace,
            props.idcAccountId,
          ),
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          IDC_ACCOUNT_ID: props.idcAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
        },
        logGroup: restApi.logGroup,
        envSchema: RegisterISBEnvironmentSchema,
        timeout: cdk.Duration.minutes(2),
      },
    );

    grantIsbSsmParameterRead(
      registerInISBLambda.lambdaFunction.role! as Role,
      sharedIdcSsmParamName(props.namespace),
      props.idcAccountId,
    );
    grantIsbDbReadWrite(
      scope,
      registerInISBLambda,
      IsbComputeStack.sharedSpokeConfig.data.accountTable,
    );
    props.isbEventBus.grantPutEventsTo(registerInISBLambda.lambdaFunction);
    IntermediateRole.addTrustedRole(registerInISBLambda.lambdaFunction.role! as Role);
    registerInISBLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          getOrgMgtRoleArn(scope, props.namespace, props.orgMgtAccountId),
          getIdcRoleArn(scope, props.namespace, props.idcAccountId),
        ],
      }),
    );

    // Create Step Function with all 6 Lambdas
    const govCloudStepFunction = new GovCloudAccountCreationStepFunctionV3(
      scope,
      "GovCloudAccountCreationStepFunction",
      {
        initiateCreationLambda: initiateCreationLambda.lambdaFunction,
        checkStatusLambda: checkStatusLambda.lambdaFunction,
        sendInvitationLambda: sendInvitationLambda.lambdaFunction,
        acceptInvitationLambda: acceptInvitationLambda.lambdaFunction,
        moveToEntryOULambda: moveToEntryOULambda.lambdaFunction,
        registerInISBLambda: registerInISBLambda.lambdaFunction,
      },
    );

    // Grant accountsLambdaFunction permission to start Step Function executions
    accountsLambdaFunction.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["states:StartExecution"],
        resources: [govCloudStepFunction.stateMachine.stateMachineArn],
      }),
    );

    // Grant permission to describe executions (execution ARN format is different)
    accountsLambdaFunction.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["states:DescribeExecution"],
        resources: [
          Stack.of(scope).formatArn({
            service: "states",
            resource: "execution",
            resourceName: `${govCloudStepFunction.stateMachine.stateMachineName}:*`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // Add Step Function ARN to accountsLambdaFunction environment
    accountsLambdaFunction.lambdaFunction.addEnvironment(
      "GOVCLOUD_CREATION_STEP_FUNCTION_ARN",
      govCloudStepFunction.stateMachine.stateMachineArn,
    );

    const accountsResource = restApi.root.addResource("accounts", {
      defaultIntegration: new LambdaIntegration(
        accountsLambdaFunction.lambdaFunction,
        { allowTestInvoke: true, proxy: true },
      ),
    });
    accountsResource.addMethod("GET");
    accountsResource.addMethod("POST", undefined, {
      authorizationType: apigateway.AuthorizationType.CUSTOM,
    });
    addCorsOptions(accountsResource);

    const accountIdResource = accountsResource.addResource("{awsAccountId}");
    accountIdResource.addMethod("GET");
    addCorsOptions(accountIdResource);

    const accountRetryCleanupResource =
      accountIdResource.addResource("retryCleanup");
    accountRetryCleanupResource.addMethod("POST");
    addCorsOptions(accountRetryCleanupResource);

    const accountEjectResource = accountIdResource.addResource("eject");
    accountEjectResource.addMethod("POST");
    addCorsOptions(accountEjectResource);

    const accountsUnregisteredResource =
      accountsResource.addResource("unregistered");
    accountsUnregisteredResource.addMethod("GET");
    addCorsOptions(accountsUnregisteredResource);

    // Add GovCloud account creation resource
    const govcloudResource = accountsResource.addResource("govcloud");
    const govcloudCreateResource = govcloudResource.addResource("create");
    govcloudCreateResource.addMethod("POST");
    addCorsOptions(govcloudCreateResource);

    // Add status polling endpoint
    const govcloudStatusResource = govcloudCreateResource.addResource("status");
    const govcloudExecutionIdResource = govcloudStatusResource.addResource("{executionId}");
    govcloudExecutionIdResource.addMethod("GET");
    addCorsOptions(govcloudExecutionIdResource);

    // Add available accounts endpoint
    const govcloudAvailableResource = govcloudResource.addResource("available");
    govcloudAvailableResource.addMethod("GET");
    addCorsOptions(govcloudAvailableResource);
  }
}
