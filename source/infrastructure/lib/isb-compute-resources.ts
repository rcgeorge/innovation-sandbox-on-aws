// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, CfnCondition, CfnOutput } from "aws-cdk-lib";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { AccountCleaner } from "@amzn/innovation-sandbox-infrastructure/components/account-cleaner/account-cleaner";
import { RestApi } from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { CloudfrontUiApi } from "@amzn/innovation-sandbox-infrastructure/components/cloudfront/cloudfront-ui-api";
import { DeploymentUUID } from "@amzn/innovation-sandbox-infrastructure/components/custom-resources/deployment-uuid";
import { IsbInternalCore } from "@amzn/innovation-sandbox-infrastructure/components/events/isb-internal-core";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { AnonymizedMetricsReporting } from "@amzn/innovation-sandbox-infrastructure/components/observability/anonymized-metrics-reporting";
import { CostReportingLambda } from "@amzn/innovation-sandbox-infrastructure/components/observability/cost-reporting-lambda";
import { LogArchiving } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-archiving";
import { IsbLogGroups } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-groups";
import { LogInsightsQueries } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-insights-queries";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { IntermediateRole } from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";

export interface IsbComputeResourcesProps {
  namespace: string;
  orgMgtAccountId: string;
  idcAccountId: string;
  allowListedCidr: string[];
  useStableTaggingCondition: CfnCondition;
  isGovCloud?: boolean;
  isbManagedRegions: string[];
  commercialBridgeApiUrl?: string;
  commercialBridgeApiKeySecretArn?: string;
}

export class IsbComputeResources {
  public static namespace: string;
  public static globalLogGroup: LogGroup;
  public static cleanupLogGroup: LogGroup;

  constructor(scope: Construct, props: IsbComputeResourcesProps) {
    //init global log group for use by rest of solution
    const kmsKey = IsbKmsKeys.get(scope, props.namespace);
    kmsKey.grantEncryptDecrypt(
      new ServicePrincipal("logs.amazonaws.com", { region: Aws.REGION }),
    );

    IsbComputeResources.namespace = props.namespace;
    IsbComputeResources.globalLogGroup = IsbLogGroups.globalLogGroup(
      scope,
      props.namespace,
    );
    IsbComputeResources.cleanupLogGroup = IsbLogGroups.cleanupLogGroup(
      scope,
      props.namespace,
    );

    kmsKey.grantEncryptDecrypt(new ServicePrincipal("events.amazonaws.com"));
    //log group initialized

    const deploymentUUID = new DeploymentUUID(scope, "DeploymentUUID", {
      namespace: props.namespace,
    });

    const intermediateRole = IntermediateRole.getInstance(scope, {
      namespace: props.namespace,
      idcAccountId: props.idcAccountId,
      orgMgtAccountId: props.orgMgtAccountId,
    });

    addCfnGuardSuppression(intermediateRole, [
      "CFN_NO_EXPLICIT_RESOURCE_NAMES",
    ]);

    const isbInternalCore = new IsbInternalCore(scope, {
      namespace: props.namespace,
      kmsKey,
      orgMgtAccountId: props.orgMgtAccountId,
      idcAccountId: props.idcAccountId,
      isGovCloud: props.isGovCloud,
      isbManagedRegions: props.isbManagedRegions,
      commercialBridgeApiUrl: props.commercialBridgeApiUrl,
      commercialBridgeApiKeySecretArn: props.commercialBridgeApiKeySecretArn,
    });

    new AccountCleaner(scope, "AccountCleaner", {
      eventBus: isbInternalCore.eventBus,
      namespace: props.namespace,
      orgMgtAccountId: props.orgMgtAccountId,
      idcAccountId: props.idcAccountId,
      useStableTaggingCondition: props.useStableTaggingCondition,
    });

    const restApi = new RestApi(scope, "IsbRestApi", {
      intermediateRole: intermediateRole,
      namespace: props.namespace,
      idcAccountId: props.idcAccountId,
      orgMgtAccountId: props.orgMgtAccountId,
      isbEventBus: isbInternalCore.eventBus,
      allowListedCidr: props.allowListedCidr,
      isGovCloud: props.isGovCloud,
    });

    // CloudFront is not available in GovCloud regions
    // Use Container stack for frontend deployment in GovCloud instead
    if (!props.isGovCloud) {
      new CloudfrontUiApi(scope, "CloudFrontUiApi", {
        restApi,
        namespace: props.namespace,
      });
    }

    new LogInsightsQueries(scope, "LogInsightsQueries", {
      namespace: props.namespace,
    });

    new AnonymizedMetricsReporting(scope, "AnonymizedMetrics", {
      metricsUrl: "https://metrics.awssolutionsbuilder.com/generic",
      solutionId: getContextFromMapping(scope, "solutionId"),
      solutionVersion: getContextFromMapping(scope, "version"),
      deploymentUUID: deploymentUUID.deploymentUUID,
      namespace: props.namespace,
      orgManagementAccountId: props.orgMgtAccountId,
    });

    new CostReportingLambda(scope, "CostReportingLambda", {
      namespace: props.namespace,
      orgMgtAccountId: props.orgMgtAccountId,
      idcAccountId: props.idcAccountId,
      isbManagedRegions: props.isbManagedRegions,
      commercialBridgeApiUrl: props.commercialBridgeApiUrl,
      commercialBridgeApiKeySecretArn: props.commercialBridgeApiKeySecretArn,
    });

    new LogArchiving(scope, "LogArchiving", {
      namespace: props.namespace,
    });

    new CfnOutput(scope, "DeploymentUUIDOutput", {
      value: deploymentUUID.deploymentUUID,
    });
  }
}
