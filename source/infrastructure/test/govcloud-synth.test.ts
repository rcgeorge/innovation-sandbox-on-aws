// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Synthesizes the stacks in GovCloud mode (all feature flags on) to exercise the
// GovCloud-only constructs the commercial snapshot test never reaches: the
// ALB+S3 front door, the private API endpoint, the cost-bridge wiring, the
// cross-partition provisioning Step Function, the partition-substituted SCPs,
// and the gated Organizations permissions. Primarily a "does it synth without
// throwing" smoke test, plus a few targeted assertions on the fixed behaviors.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ensureDirSync } from "fs-extra";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { IsbAccountPoolStack } from "@amzn/innovation-sandbox-infrastructure/isb-account-pool-stack";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { IsbDataStack } from "@amzn/innovation-sandbox-infrastructure/isb-data-stack";
import { AssetCode, Code } from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { ISource, Source } from "aws-cdk-lib/aws-s3-deployment";

const govCloudContext: Record<string, string> = {
  isGovCloud: "true",
  hostingMode: "alb-s3",
  certificateArn:
    "arn:aws-us-gov:acm:us-gov-west-1:111111111111:certificate/abc",
  enableCommercialBridge: "true",
  commercialBridgeApiUrl: "https://bridge.example.com",
  commercialBridgeClientCertSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:x",
  commercialBridgeTrustAnchorArn: "arn:aws:rolesanywhere:us-east-1:1:trust-anchor/x",
  commercialBridgeProfileArn: "arn:aws:rolesanywhere:us-east-1:1:profile/x",
  commercialBridgeRoleArn: "arn:aws:iam::1:role/x",
  commercialBridgeGovCloudRegions: "us-gov-west-1,us-gov-east-1",
  enableGovCloudAccountProvisioning: "true",
  govCloudHomeRegion: "us-gov-west-1",
};

beforeAll(async () => {
  vi.spyOn(Code, "fromAsset").mockImplementation(() => {
    const mockCode = new AssetCode("/mock/path");
    mockCode.bind = () => ({
      s3Location: { bucketName: "mock-bucket", objectKey: "mock-key" },
    });
    mockCode.bindToResource = vi.fn();
    return mockCode;
  });

  vi.spyOn(Source, "asset").mockImplementation((p) => {
    const mockBucket = { bucketName: "mock-source-bucket" } as IBucket;
    return {
      bind: () => ({
        bucket: mockBucket,
        zipObjectKey: "mock-source-key",
        deployTime: true,
        objectKey: "mock-object-key",
      }),
      bindToStackSynthesizer: vi.fn(),
      path: p || "/mock/asset/path",
    } as ISource;
  });

  vi.mock("child_process", () => ({
    execSync: vi.fn().mockImplementation(() => Buffer.from("mocked execSync")),
    execFileSync: vi.fn().mockImplementation(() => Buffer.from("mocked")),
  }));

  vi.mock("fs-extra", () => ({
    moveSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    ensureDirSync: vi.fn(),
  }));
});

afterAll(() => {
  if (createdHelperStub && existsSync(helperBinPath)) {
    rmSync(helperBinPath);
  }
  vi.restoreAllMocks();
});

// The stacks cross-reference each other (via IsbComputeStack.sharedSpokeConfig),
// so — like the real bin/app.ts — they must be built in a single App, in the
// AccountPool → Data → Compute order that sets the shared config before it is
// consumed. Build once and assert against the resulting templates.
let computeT: Template;
let accountPoolT: Template;
let synthError: unknown;

// The roles-anywhere layer asserts its credential-helper binary exists on disk
// (it is fetched at build time by build.sh and gitignored). Provide a stub so
// GovCloud synth can run in CI without first building the real binary.
const helperBinDir = path.join(
  __dirname,
  "..",
  "..",
  "layers",
  "roles-anywhere-helper",
  "bin",
);
const helperBinPath = path.join(helperBinDir, "aws_signing_helper");
let createdHelperStub = false;

beforeAll(() => {
  try {
    if (!existsSync(helperBinPath)) {
      mkdirSync(helperBinDir, { recursive: true });
      writeFileSync(helperBinPath, "#!/bin/sh\n");
      createdHelperStub = true;
    }
    ensureDirSync(path.join(__dirname, "..", "..", "frontend", "dist"));
    const app = new App({ context: govCloudContext });
    const accountPool = new IsbAccountPoolStack(app, "AccountPool");
    // Data must exist before Compute so the shared spoke config is populated.
    new IsbDataStack(app, "Data");
    const compute = new IsbComputeStack(app, "Compute");
    accountPoolT = Template.fromStack(accountPool);
    computeT = Template.fromStack(compute);
  } catch (e) {
    synthError = e;
  }
});

describe("GovCloud-mode synthesis", () => {
  it("synthesizes all stacks without error", () => {
    expect(synthError).toBeUndefined();
  });

  it("the ALB WAF keys off the connection source IP (not X-Forwarded-For)", () => {
    // Two WebACLs exist: the front-facing ALB WAF (must use source IP) and the
    // private API Gateway WAF (legitimately keeps X-Forwarded-For, since it sits
    // BEHIND the ALB which injects a trusted XFF). Find the source-IP one and
    // assert it carries no forwarded-IP config.
    const acls = Object.values(
      computeT.findResources("AWS::WAFv2::WebACL"),
    ) as any[];
    const albWaf = acls.find((acl) =>
      (acl.Properties.Rules ?? []).some(
        (r: any) => r.Statement?.RateBasedStatement?.AggregateKeyType === "IP",
      ),
    );
    expect(albWaf).toBeDefined();
    expect(JSON.stringify(albWaf.Properties.Rules)).not.toContain(
      "X-Forwarded-For",
    );
  });

  it("SPA bucket policy grants GetObject to AnyPrincipal scoped by SourceVpce", () => {
    const policies = JSON.stringify(
      computeT.findResources("AWS::S3::BucketPolicy"),
    );
    expect(policies).toContain("s3:GetObject");
    expect(policies).toContain("aws:SourceVpce");
    // AnyPrincipal renders as {"AWS":"*"} — a ServicePrincipal would be {"Service":"*"}.
    expect(policies).not.toContain('"Service":"*"');
  });

  it("provisioning Step Function has Retry and Catch on its tasks", () => {
    const machines = JSON.stringify(
      computeT.findResources("AWS::StepFunctions::StateMachine"),
    );
    expect(machines).toContain("Retry");
    expect(machines).toContain("Catch");
  });

  it("renders SCPs in the aws-us-gov partition (no unsubstituted placeholder)", () => {
    const scps = JSON.stringify(
      accountPoolT.findResources("AWS::Organizations::Policy"),
    );
    expect(scps).toContain("arn:aws-us-gov:");
    expect(scps).not.toContain("${partition}");
  });

  it("grants the org-management role the provisioning Organizations actions", () => {
    const policies = JSON.stringify(
      accountPoolT.findResources("AWS::IAM::Policy"),
    );
    expect(policies).toContain("organizations:InviteAccountToOrganization");
    expect(policies).toContain("organizations:TagResource");
    expect(policies).toContain("organizations:ListParents");
  });
});
