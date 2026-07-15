#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as cdk from "aws-cdk-lib";

import { getSolutionContext } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { isGovCloud } from "@amzn/innovation-sandbox-infrastructure/helpers/govcloud-mode";
import { IsbAccountPoolStack } from "@amzn/innovation-sandbox-infrastructure/isb-account-pool-stack";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { IsbDataStack } from "@amzn/innovation-sandbox-infrastructure/isb-data-stack";
import { IsbIdcStack } from "@amzn/innovation-sandbox-infrastructure/isb-idc-stack";
import { SolutionsEngineeringSynthesizer } from "@amzn/innovation-sandbox-infrastructure/stack-synthesizers/solutions-engineering-synthesizer";

const app = new cdk.App();

const context = getSolutionContext(app.node);

// The AWS::CDK::Metadata resource is not supported by GovCloud CloudFormation.
// Disable analytics/version reporting there so the synthesized templates omit
// it. Commercial deployments keep the default (enabled) and are unchanged.
const analyticsReporting = isGovCloud(app) ? false : undefined;

const synthesizer = new SolutionsEngineeringSynthesizer({
  generateBootstrapVersionRule: false,
  fileAssetsBucketName:
    context.distOutputBucket && `${context.distOutputBucket}-\${AWS::Region}`,
  bucketPrefix: context.bucketPrefix,
  outdir: app.outdir,
});

new IsbAccountPoolStack(app, "InnovationSandbox-AccountPool", {
  description: `(${context.solutionId}) ${context.solutionName} ${context.version}`,
  synthesizer: synthesizer,
  analyticsReporting,
});

new IsbIdcStack(app, "InnovationSandbox-IDC", {
  description: `(${context.solutionId}-IdcStack) ${context.solutionName} ${context.version}`,
  synthesizer: synthesizer,
  analyticsReporting,
});

new IsbDataStack(app, "InnovationSandbox-Data", {
  description: `(${context.solutionId}-DataStack) ${context.solutionName} ${context.version}`,
  synthesizer: synthesizer,
  analyticsReporting,
});

new IsbComputeStack(app, "InnovationSandbox-Compute", {
  description: `(${context.solutionId}-ComputeStack) ${context.solutionName} ${context.version}`,
  synthesizer: synthesizer,
  analyticsReporting,
});
