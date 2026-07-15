#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as cdk from "aws-cdk-lib";

import { CommercialBridgeCostStack } from "../lib/commercial-bridge-cost-stack.js";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || "us-east-1",
};

// IAM Roles Anywhere trust configuration (self-signed CA bundle). Provide the
// CA certificate (PEM) via the `caCertificatePem` context or ROLES_ANYWHERE_CA_CERT
// env var, and the allowed client-certificate common name via `allowedCn`.
const caCertificatePem =
  app.node.tryGetContext("caCertificatePem") ??
  process.env.ROLES_ANYWHERE_CA_CERT;
const allowedCn =
  app.node.tryGetContext("allowedCn") ??
  process.env.ROLES_ANYWHERE_ALLOWED_CN ??
  "govcloud-commercial-bridge";

new CommercialBridgeCostStack(app, "CommercialBridge-Cost", {
  env,
  description:
    "Commercial-partition cost API for Innovation Sandbox GovCloud deployments (SO0284)",
  caCertificatePem,
  allowedCn,
});
