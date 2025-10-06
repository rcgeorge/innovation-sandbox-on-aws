// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

import { ApplicationInsights } from "@amzn/innovation-sandbox-infrastructure/components/observability/app-insights";
import {
  addParameterGroup,
  ParameterWithLabel,
  YesNoParameter,
} from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { NamespaceParam } from "@amzn/innovation-sandbox-infrastructure/helpers/namespace-param";
import {
  getSharedSsmParamValues,
  SharedSpokeConfig,
} from "@amzn/innovation-sandbox-infrastructure/helpers/shared-ssm-params";
import { applyIsbTag } from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import fs from "fs";
import path from "path";

export class IsbComputeStack extends Stack {
  public static sharedSpokeConfig: SharedSpokeConfig;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    /* solution input parameters go here*/
    const namespaceParam = new NamespaceParam(this);

    const orgMgtAccountId = new ParameterWithLabel(this, "OrgMgtAccountId", {
      label: "Org Management Account Id",
      description:
        "The AWS Account Id of the org's management account where the account pool stack is deployed",
      allowedPattern: "^[0-9]{12}$",
    });

    const idcAccountId = new ParameterWithLabel(this, "IdcAccountId", {
      label: "IDC Account Id",
      description:
        "The AWS Account Id where the IAM Identity Center is configured",
      allowedPattern: "^[0-9]{12}$",
    });

    const allowListedCidr = new ParameterWithLabel(
      this,
      "AllowListedIPRanges",
      {
        type: "CommaDelimitedList",
        label: "Allow Listed IP Ranges",
        description:
          "Comma separated list of CIDR ranges that allow access to the API. To allow all the entire internet, leave" +
          " the default 0.0.0.0/1,128.0.0.0/1",
        default: "0.0.0.0/1,128.0.0.0/1",
        allowedPattern:
          "^((\\d{1,3}\\.){3}\\d{1,3}/([0-9]|[1-2][0-9]|3[0-2]))(\\s*,\\s*((\\d{1,3}\\.){3}\\d{1,3}/([0-9]|[1-2][0-9]|3[0-2])))*$",
      },
    );

    const useStableTagging = new YesNoParameter(this, "UseStableTagging", {
      label: "Use Stable Tagging",
      description:
        "Automatically use the most up to date and secure account cleaner image up until the next minor release. Selecting 'No' will pull the image as originally released, without any security updates.",
      default: "Yes",
    });

    const acceptTerms = new ParameterWithLabel(
      this,
      "AcceptSolutionTermsOfUse",
      {
        label: "Accept Solution Terms of Use",
        description: fs.readFileSync(
          path.join(__dirname, "assets/terms-of-use.txt"),
          "utf-8",
        ),
        allowedPattern: "^Accept$",
        constraintDescription:
          'You must enter "Accept" to deploy this template',
      },
    );

    addParameterGroup(this, {
      label: "Compute Stack Configuration",
      parameters: [
        namespaceParam.namespace,
        orgMgtAccountId,
        idcAccountId,
        allowListedCidr,
        useStableTagging,
        acceptTerms,
      ],
    });

    IsbComputeStack.sharedSpokeConfig = getSharedSsmParamValues(
      this,
      namespaceParam.namespace.valueAsString,
      idcAccountId.valueAsString,
      orgMgtAccountId.valueAsString,
    );

    // Get isGovCloud from CDK context (set via --context isGovCloud=true/false)
    const isGovCloud = this.node.tryGetContext("isGovCloud") === "true";

    // Get ISB managed regions from CDK context
    const isbManagedRegions = (this.node.tryGetContext("isbManagedRegions") as string || "").split(",").filter(r => r.length > 0);

    // Get commercial bridge config from CDK context (optional - GovCloud only)
    const commercialBridgeApiUrl = this.node.tryGetContext("commercialBridgeApiUrl") as string | undefined;
    const commercialBridgeApiKeySecretArn = this.node.tryGetContext("commercialBridgeApiKeySecretArn") as string | undefined;

    new IsbComputeResources(this, {
      namespace: namespaceParam.namespace.valueAsString,
      orgMgtAccountId: orgMgtAccountId.valueAsString,
      idcAccountId: idcAccountId.valueAsString,
      allowListedCidr: allowListedCidr.valueAsList,
      useStableTaggingCondition: useStableTagging.getCondition(),
      isGovCloud: isGovCloud,
      isbManagedRegions: isbManagedRegions,
      commercialBridgeApiUrl: commercialBridgeApiUrl,
      commercialBridgeApiKeySecretArn: commercialBridgeApiKeySecretArn,
    });

    new ApplicationInsights(this, "IsbApplicationInsights", {
      namespace: namespaceParam.namespace.valueAsString,
    });

    applyIsbTag(this, `${namespaceParam.namespace.valueAsString}`);
  }
}
