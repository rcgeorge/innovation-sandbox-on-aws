# Roles Anywhere Helper Lambda Layer

Packages the [AWS IAM Roles Anywhere credential helper](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/credential-helper.html)
(`aws_signing_helper`) so GovCloud Lambdas can obtain temporary commercial-partition
credentials from a certificate, then SigV4-sign requests to the commercial bridge API.

The `CommercialBridgeClient` (`source/common/isb-services/cost/commercial-bridge-client.ts`)
invokes the binary at `/opt/bin/aws_signing_helper`, which is where a Lambda layer's
`bin/` directory is mounted.

## Building

```shell
./build.sh
```

Downloads the **arm64** binary (the ISB Lambdas run on ARM64) into `bin/`. The
CDK layer construct packages `bin/` as the layer content. `bin/` is gitignored —
the binary is fetched at build time, not committed.

Override the version with `ROLES_ANYWHERE_HELPER_VERSION` if needed.
