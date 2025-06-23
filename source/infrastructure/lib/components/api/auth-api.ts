// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CfnOutput, Duration, SecretValue, aws_iam } from "aws-cdk-lib";
import {
  AuthorizationType,
  LambdaIntegration,
} from "aws-cdk-lib/aws-apigateway";
import { Role } from "aws-cdk-lib/aws-iam";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import path from "path";

import { SecretsRotatorEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/secrets-rotator-lambda-environment.js";
import { SsoLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/sso-lambda-environment.js";
import {
  SECRET_NAME_PREFIX,
  sharedIdcSsmParamName,
} from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import {
  RestApi as ApiGatewayRestApi,
  RestApiProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import {
  IntermediateRole,
  getIdcRoleArn,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbAppConfigRead,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class AuthApi {
  readonly jwtTokenSecretArn: string;

  constructor(
    restApi: ApiGatewayRestApi,
    scope: Construct,
    props: RestApiProps,
  ) {
    const kmsKey = IsbKmsKeys.get(scope, props.namespace);

    const jwtSecretName = `${SECRET_NAME_PREFIX}/${props.namespace}/Auth/JwtSecret`;
    const jwtTokenSecret = new Secret(scope, "JwtSecret", {
      secretName: jwtSecretName,
      description: "The secret for JWT used by Innovation Sandbox",
      encryptionKey: kmsKey,
      generateSecretString: {
        passwordLength: 32,
      },
    });
    this.jwtTokenSecretArn = jwtTokenSecret.secretArn;

    const jwtSecretRotatorLambda = new IsbLambdaFunction(
      scope,
      "JwtSecretRotator",
      {
        description: "Rotates the Isb Jwt Secret",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "..",
          "source",
          "lambdas",
          "helpers",
          "secret-rotator",
          "src",
          "secret-rotator-handler.ts",
        ),
        namespace: props.namespace,
        handler: "handler",
        logGroup: restApi.logGroup,
        reservedConcurrentExecutions: 1,
        envSchema: SecretsRotatorEnvironmentSchema,
        environment: {},
      },
    );
    jwtTokenSecret.addRotationSchedule("RotationSchedule", {
      rotationLambda: jwtSecretRotatorLambda.lambdaFunction,
      automaticallyAfter: Duration.days(30),
      rotateImmediatelyOnUpdate: true,
    });

    const idpCertSecretName = `${SECRET_NAME_PREFIX}/${props.namespace}/Auth/IdpCert`;
    const idpCertSecret = new Secret(scope, "IdpCert", {
      secretName: idpCertSecretName,
      description:
        "IAM Identity Center Certificate of the ISB SAML 2.0 custom app",
      encryptionKey: kmsKey,
      secretStringValue: SecretValue.unsafePlainText(
        "Please paste the IAM Identity Center Certificate of the" +
          " Innovation Sandbox SAML 2.0 custom application here",
      ),
    });

    const secretAccessPolicy = new aws_iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      effect: aws_iam.Effect.ALLOW,
      resources: [jwtTokenSecret.secretArn, idpCertSecret.secretArn],
    });

    new CfnOutput(scope, "JwtSecretArn", {
      value: jwtTokenSecret.secretArn,
      description: "The ARN of the created secret for JWT",
    });

    new CfnOutput(scope, "IdpCertArn", {
      value: idpCertSecret.secretArn,
      description: "The ARN of the created secret to store the IDP certificate",
    });

    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const ssoLambda = new IsbLambdaFunction(scope, "SsoHandler", {
      description: "Handles SSO operations",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "..",
        "source",
        "lambdas",
        "api",
        "sso-handler",
        "src",
        "index.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      environment: {
        JWT_SECRET_NAME: jwtSecretName,
        IDP_CERT_SECRET_NAME: idpCertSecretName,
        POWERTOOLS_SERVICE_NAME: "SsoHandler",
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        IDC_ROLE_ARN: getIdcRoleArn(scope, props.namespace, props.idcAccountId),
        ISB_NAMESPACE: props.namespace,
        APP_CONFIG_APPLICATION_ID: configApplicationId,
        APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
        APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
        AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId}`,
      },
      logGroup: restApi.logGroup,
      envSchema: SsoLambdaEnvironmentSchema,
    });

    grantIsbSsmParameterRead(
      ssoLambda.lambdaFunction.role! as Role,
      sharedIdcSsmParamName(props.namespace),
      props.idcAccountId,
    );
    grantIsbAppConfigRead(scope, ssoLambda, globalConfigConfigurationProfileId);
    addAppConfigExtensionLayer(ssoLambda);
    ssoLambda.lambdaFunction.addToRolePolicy(secretAccessPolicy);
    kmsKey.grantEncryptDecrypt(ssoLambda.lambdaFunction);

    IntermediateRole.addTrustedRole(ssoLambda.lambdaFunction.role! as Role);

    const ssoResource = restApi.root
      .addResource("auth", {
        defaultMethodOptions: {
          authorizationType: AuthorizationType.NONE,
          authorizer: undefined,
        },
      })
      .addResource("{action+}", {
        defaultIntegration: new LambdaIntegration(ssoLambda.lambdaFunction, {
          proxy: true,
          allowTestInvoke: true,
        }),
      });
    const methodGet = ssoResource.addMethod("GET");
    const methodPost = ssoResource.addMethod("POST");
    const methodOptions = ssoResource.addMethod("OPTIONS");

    addCfnGuardSuppression(ssoResource, [
      "API_GW_METHOD_AUTHORIZATION_TYPE_RULE",
    ]);
    addCfnGuardSuppression(methodGet, [
      "API_GW_METHOD_AUTHORIZATION_TYPE_RULE",
    ]);
    addCfnGuardSuppression(methodPost, [
      "API_GW_METHOD_AUTHORIZATION_TYPE_RULE",
    ]);
    addCfnGuardSuppression(methodOptions, [
      "API_GW_METHOD_AUTHORIZATION_TYPE_RULE",
    ]);
  }
}
