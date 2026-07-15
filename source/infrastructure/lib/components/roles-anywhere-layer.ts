// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack } from "aws-cdk-lib";
import {
  Architecture,
  Code,
  LayerVersion,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { existsSync } from "fs";
import path from "path";

const instances: { [stackName: string]: LayerVersion } = {};

/**
 * Returns (creating once per stack) a Lambda layer packaging the AWS IAM Roles
 * Anywhere credential helper (aws_signing_helper) at /opt/bin/aws_signing_helper.
 * Required by CommercialBridgeClient (GovCloud) to obtain temporary
 * commercial-partition credentials for SigV4-signing bridge API requests.
 *
 * The arm64 binary must be downloaded before synth via
 * `source/layers/roles-anywhere-helper/build.sh`. Only used in commercial-bridge
 * (GovCloud) mode, so commercial deployments never reference it.
 */
export function getRolesAnywhereLayer(scope: Construct): LayerVersion {
  const stack = Stack.of(scope);
  const key = stack.stackName;
  if (instances[key]) {
    return instances[key]!;
  }

  const layerPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "layers",
    "roles-anywhere-helper",
  );

  if (!existsSync(path.join(layerPath, "bin", "aws_signing_helper"))) {
    throw new Error(
      "roles-anywhere-helper binary not found. Run " +
        "source/layers/roles-anywhere-helper/build.sh before deploying with " +
        "enableCommercialBridge=true.",
    );
  }

  const layer = new LayerVersion(stack, "RolesAnywhereHelperLayer", {
    // The layer's bin/ is mounted at /opt/bin/ at runtime.
    code: Code.fromAsset(layerPath, {
      exclude: ["*.md", "*.sh", ".gitignore"],
    }),
    description:
      "AWS IAM Roles Anywhere credential helper for the commercial bridge",
    compatibleRuntimes: [Runtime.NODEJS_22_X],
    compatibleArchitectures: [Architecture.ARM_64],
  });

  instances[key] = layer;
  return layer;
}
