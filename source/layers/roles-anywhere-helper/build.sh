#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Downloads the AWS IAM Roles Anywhere credential helper (aws_signing_helper)
# into bin/ so it can be packaged as a Lambda layer. The ISB Lambdas run on
# ARM64 (see IsbLambdaFunction), so the arm64 build is required — an amd64
# binary will fail to exec on the function.
#
# The binary is executed inside a Lambda that holds the client certificate/key
# and the function's IAM credentials, so its integrity is verified against a
# pinned SHA-256 before it is packaged. A compromised mirror, MITM, or silently
# re-published artifact is rejected rather than shipped.
#
# Supply the expected digest one of two ways (checked in this order):
#   1. ROLES_ANYWHERE_HELPER_SHA256 environment variable, or
#   2. a sidecar file: checksums/<VERSION>-<ARCH>.sha256 (just the hex digest).
# Obtain the digest from a trusted source (e.g. hash the binary from a machine
# you trust, or AWS-provided release metadata) and commit the sidecar file.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/bin"
VERSION="${ROLES_ANYWHERE_HELPER_VERSION:-1.1.1}"
ARCH="linux-arm64"
CHECKSUM_FILE="$SCRIPT_DIR/checksums/${VERSION}-${ARCH}.sha256"

# Resolve the expected checksum: env var takes precedence over the sidecar file.
EXPECTED_SHA256="${ROLES_ANYWHERE_HELPER_SHA256:-}"
if [[ -z "$EXPECTED_SHA256" && -f "$CHECKSUM_FILE" ]]; then
  EXPECTED_SHA256="$(tr -d '[:space:]' < "$CHECKSUM_FILE")"
fi

if [[ -z "$EXPECTED_SHA256" ]]; then
  echo "ERROR: No expected SHA-256 for aws_signing_helper v${VERSION} (${ARCH})." >&2
  echo "       Set ROLES_ANYWHERE_HELPER_SHA256 or create ${CHECKSUM_FILE}." >&2
  echo "       Refusing to package an unverified credential-helper binary." >&2
  exit 1
fi

mkdir -p "$BIN_DIR"

echo "Downloading aws_signing_helper v${VERSION} (${ARCH})..."
curl -fsSL \
  "https://rolesanywhere.amazonaws.com/releases/${VERSION}/${ARCH}/aws_signing_helper" \
  -o "$BIN_DIR/aws_signing_helper"

# Verify integrity before making it executable or packaging it.
echo "Verifying SHA-256..."
ACTUAL_SHA256="$(sha256sum "$BIN_DIR/aws_signing_helper" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  rm -f "$BIN_DIR/aws_signing_helper"
  echo "ERROR: Checksum mismatch for aws_signing_helper." >&2
  echo "       expected: $EXPECTED_SHA256" >&2
  echo "       actual:   $ACTUAL_SHA256" >&2
  echo "       Deleted the downloaded binary. Aborting." >&2
  exit 1
fi

chmod +x "$BIN_DIR/aws_signing_helper"

echo "aws_signing_helper v${VERSION} verified and downloaded to $BIN_DIR/aws_signing_helper"
