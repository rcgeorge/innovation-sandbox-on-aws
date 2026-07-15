#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Downloads the AWS IAM Roles Anywhere credential helper (aws_signing_helper)
# into bin/ so it can be packaged as a Lambda layer. The ISB Lambdas run on
# ARM64 (see IsbLambdaFunction), so the arm64 build is required — an amd64
# binary will fail to exec on the function.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/bin"
VERSION="${ROLES_ANYWHERE_HELPER_VERSION:-1.1.1}"
ARCH="linux-arm64"

mkdir -p "$BIN_DIR"

echo "Downloading aws_signing_helper v${VERSION} (${ARCH})..."
curl -fsSL \
  "https://rolesanywhere.amazonaws.com/releases/${VERSION}/${ARCH}/aws_signing_helper" \
  -o "$BIN_DIR/aws_signing_helper"

chmod +x "$BIN_DIR/aws_signing_helper"

echo "aws_signing_helper downloaded to $BIN_DIR/aws_signing_helper"
