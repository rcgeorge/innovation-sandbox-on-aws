# IAM Roles Anywhere Helper Lambda Layer

This Lambda layer provides the AWS IAM Roles Anywhere credential helper tool for certificate-based authentication from Lambda functions.

## Contents

- `/opt/bin/aws_signing_helper` - AWS IAM Roles Anywhere credential helper binary

## Build

```bash
# Linux/macOS
./build.sh

# Windows
powershell -ExecutionPolicy Bypass -File build.ps1
```

## Usage in Lambda

The binary is available at `/opt/bin/aws_signing_helper` when this layer is attached to a Lambda function.

See `source/common/isb-services/commercial-bridge-client.ts` for usage example.
