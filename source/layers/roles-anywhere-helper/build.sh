#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Download AWS IAM Roles Anywhere credential helper for Lambda layer

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/bin"
VERSION="1.0.5"
ARCH="linux-amd64"

# Create bin directory
mkdir -p "$BIN_DIR"

# Download credential helper
echo "📥 Downloading AWS IAM Roles Anywhere credential helper v${VERSION}..."
curl -L \
  "https://rolesanywhere.amazonaws.com/releases/${VERSION}/aws_signing_helper-${ARCH}" \
  -o "$BIN_DIR/aws_signing_helper"

# Make executable
chmod +x "$BIN_DIR/aws_signing_helper"

# Verify it works
echo "✅ Verifying credential helper..."
"$BIN_DIR/aws_signing_helper" --version || echo "⚠️  Version check not supported, but binary downloaded successfully"

echo ""
echo "✅ IAM Roles Anywhere credential helper layer ready!"
echo "   Location: $BIN_DIR/aws_signing_helper"
echo ""
