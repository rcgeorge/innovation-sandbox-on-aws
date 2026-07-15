// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, CfnOutput, Duration, Token } from "aws-cdk-lib";
import {
  RestApi as ApiGatewayRestApi,
  AuthorizationType,
  EndpointType,
  IdentitySource,
  LogGroupLogDestination,
  RequestAuthorizer,
} from "aws-cdk-lib/aws-apigateway";
import { IInterfaceVpcEndpoint } from "aws-cdk-lib/aws-ec2";
import { EventBus } from "aws-cdk-lib/aws-events";
import {
  AnyPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import path from "path";

import { AuthorizerLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/authorizer-lambda-environment.js";
import { SecretsRotatorEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/secrets-rotator-lambda-environment.js";
import { SECRET_NAME_PREFIX } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { AccountsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/accounts-api";
import { AuthApi } from "@amzn/innovation-sandbox-infrastructure/components/api/auth-api";
import { BlueprintsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/blueprints-api";
import { ConfigurationsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/configurations-api";
import { LeaseTemplatesApi } from "@amzn/innovation-sandbox-infrastructure/components/api/lease-templates-api";
import { LeasesApi } from "@amzn/innovation-sandbox-infrastructure/components/api/leases-api";
import { Waf } from "@amzn/innovation-sandbox-infrastructure/components/api/waf";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { getHostingMode } from "@amzn/innovation-sandbox-infrastructure/helpers/govcloud-mode";
import { grantIsbAppConfigRead } from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export interface RestApiProps {
  intermediateRole: Role;
  namespace: string;
  idcAccountId: string;
  orgMgtAccountId: string;
  isbEventBus: EventBus;
  allowListedCidr: string[];
  /**
   * When provided (alb-s3 hosting mode), the API is created as a PRIVATE
   * endpoint reachable only through this execute-api interface VPC endpoint,
   * with a resource policy scoped to it. When omitted (commercial), the API
   * uses its default EDGE-optimized endpoint and no resource policy.
   */
  executeApiEndpoint?: IInterfaceVpcEndpoint;
}

export interface RestApiResourceProps extends RestApiProps {
  jwtSecret: Secret;
}

export class RestApi extends ApiGatewayRestApi {
  public readonly logGroup: LogGroup;

  constructor(scope: Construct, id: string, props: RestApiProps) {
    const kmsKey = IsbKmsKeys.get(scope, props.namespace);
    kmsKey.grantEncryptDecrypt(
      new ServicePrincipal("logs.amazonaws.com", { region: Aws.REGION }),
    );

    // Create JWT secret with rotation
    const jwtSecretName = `${SECRET_NAME_PREFIX}/${props.namespace}/Auth/JwtSecret`;
    const jwtTokenSecret = new Secret(scope, "JwtSecret", {
      secretName: jwtSecretName,
      description: "The secret for JWT used by Innovation Sandbox",
      encryptionKey: kmsKey,
      generateSecretString: {
        passwordLength: 32,
      },
    });

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
          "lambdas",
          "helpers",
          "secret-rotator",
          "src",
          "secret-rotator-handler.ts",
        ),
        namespace: props.namespace,
        handler: "handler",
        logGroup: IsbComputeResources.globalLogGroup,
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

    new CfnOutput(scope, "JwtSecretArn", {
      value: jwtTokenSecret.secretArn,
      description: "The ARN of the created secret for JWT",
    });

    const apiResourceProps: RestApiResourceProps = {
      ...props,
      jwtSecret: jwtTokenSecret,
    };

    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const authorizerLambdaFunction = new IsbLambdaFunction(
      scope,
      "AuthorizerLambdaFunction",
      {
        description:
          "Lambda function used for Innovation Sandbox on AWS API Authorization",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "authorizer",
          "src",
          "authorizer-handler.ts",
        ),
        handler: "handler",
        logGroup: IsbComputeResources.globalLogGroup,
        namespace: props.namespace,
        environment: {
          JWT_SECRET_NAME: apiResourceProps.jwtSecret.secretName,
          APP_CONFIG_APPLICATION_ID: configApplicationId,
          APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
          APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
          AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId}`,
        },
        envSchema: AuthorizerLambdaEnvironmentSchema,
      },
    );

    apiResourceProps.jwtSecret.grantRead(
      authorizerLambdaFunction.lambdaFunction,
    );
    kmsKey.grantEncryptDecrypt(authorizerLambdaFunction.lambdaFunction);
    grantIsbAppConfigRead(
      scope,
      authorizerLambdaFunction,
      globalConfigConfigurationProfileId,
    );
    addAppConfigExtensionLayer(authorizerLambdaFunction);

    const authorizer = new RequestAuthorizer(scope, "Authorizer", {
      handler: authorizerLambdaFunction.lambdaFunction,
      identitySources: [
        IdentitySource.header("Authorization"),
        IdentitySource.context("path"),
        IdentitySource.context("httpMethod"),
      ],
      resultsCacheTtl: Duration.minutes(5),
    });

    // EDGE-optimized endpoints (the API Gateway default) require CloudFront and
    // are unavailable where CloudFront is not, e.g. GovCloud.
    //  - Commercial (cloudfront): keep the default endpoint type — no
    //    endpointConfiguration, so synth output is unchanged.
    //  - alb-s3 without a shared execute-api endpoint: REGIONAL.
    //  - alb-s3 with a shared execute-api endpoint: PRIVATE, reachable only via
    //    that endpoint, with a resource policy scoped to it.
    let endpointConfiguration:
      | { types: EndpointType[]; vpcEndpoints?: IInterfaceVpcEndpoint[] }
      | undefined;
    let resourcePolicy: PolicyDocument | undefined;

    if (getHostingMode(scope) === "cloudfront") {
      endpointConfiguration = undefined;
    } else if (props.executeApiEndpoint) {
      endpointConfiguration = {
        types: [EndpointType.PRIVATE],
        vpcEndpoints: [props.executeApiEndpoint],
      };
      // Allow invokes only through the shared execute-api VPC endpoint.
      resourcePolicy = new PolicyDocument({
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            principals: [new AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
            conditions: {
              StringEquals: {
                "aws:SourceVpce": props.executeApiEndpoint.vpcEndpointId,
              },
            },
          }),
        ],
      });
    } else {
      endpointConfiguration = { types: [EndpointType.REGIONAL] };
    }

    super(scope, id, {
      description: "Innovation Sandbox on AWS Rest API",
      ...(endpointConfiguration ? { endpointConfiguration } : {}),
      ...(resourcePolicy ? { policy: resourcePolicy } : {}),
      deployOptions: {
        accessLogDestination: new LogGroupLogDestination(
          IsbComputeResources.globalLogGroup,
        ),
        tracingEnabled: true,
        throttlingRateLimit: Token.asNumber(
          getContextFromMapping(scope, "apiThrottlingRateLimit"),
        ),
        throttlingBurstLimit: Token.asNumber(
          getContextFromMapping(scope, "apiThrottlingBurstLimit"),
        ),
      },
      defaultMethodOptions: {
        authorizationType: AuthorizationType.CUSTOM,
        authorizer: authorizer,
      },
    });

    addCfnGuardSuppression(this.deploymentStage, [
      "API_GW_CACHE_ENABLED_AND_ENCRYPTED",
    ]);

    // Configure WAF with logging and alarms
    new Waf(this, "Waf", {
      namespace: props.namespace,
      resourceArn: this.deploymentStage.stageArn,
      allowListedCidr: props.allowListedCidr,
      kmsKey,
    });

    this.logGroup = IsbComputeResources.globalLogGroup;

    new AuthApi(this, scope, apiResourceProps);
    new LeasesApi(this, scope, apiResourceProps);
    new LeaseTemplatesApi(this, scope, apiResourceProps);
    new AccountsApi(this, scope, apiResourceProps);
    new BlueprintsApi(this, scope, apiResourceProps);
    new ConfigurationsApi(this, scope, apiResourceProps);
  }
}
