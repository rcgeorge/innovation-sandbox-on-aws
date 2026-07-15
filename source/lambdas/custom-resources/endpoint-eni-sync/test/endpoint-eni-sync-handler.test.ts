// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DescribeNetworkInterfacesCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  DeregisterTargetsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  RegisterTargetsCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "@amzn/innovation-sandbox-endpoint-eni-sync/endpoint-eni-sync-handler.js";

const ec2Mock = mockClient(EC2Client);
const elbMock = mockClient(ElasticLoadBalancingV2Client);

const S3_ENDPOINT = "vpce-s3aaaa";
const API_ENDPOINT = "vpce-apibbbb";
const S3_TG = "arn:aws:elasticloadbalancing:us-gov-west-1:111:targetgroup/s3/aaa";
const API_TG =
  "arn:aws:elasticloadbalancing:us-gov-west-1:111:targetgroup/api/bbb";

beforeEach(() => {
  ec2Mock.reset();
  elbMock.reset();
  vi.stubEnv(
    "ENDPOINT_TARGET_GROUP_MAPPINGS",
    `${S3_ENDPOINT}:${S3_TG},${API_ENDPOINT}:${API_TG}`,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("endpoint-eni-sync handler", () => {
  it("throws when ENDPOINT_TARGET_GROUP_MAPPINGS is not set", async () => {
    vi.unstubAllEnvs();
    await expect(handler()).rejects.toThrow(
      "ENDPOINT_TARGET_GROUP_MAPPINGS is not set",
    );
  });

  it("registers new endpoint IPs that are not yet targets", async () => {
    ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
      NetworkInterfaces: [
        { PrivateIpAddress: "10.0.1.10" },
        { PrivateIpAddress: "10.0.2.10" },
      ],
    });
    // No current targets registered
    elbMock.on(DescribeTargetHealthCommand).resolves({
      TargetHealthDescriptions: [],
    });
    elbMock.on(RegisterTargetsCommand).resolves({});

    await handler();

    const registerCalls = elbMock.commandCalls(RegisterTargetsCommand);
    expect(registerCalls.length).toBe(2); // one per mapping
    const firstInput = registerCalls[0]!.args[0].input;
    expect(firstInput.Targets).toEqual([
      { Id: "10.0.1.10" },
      { Id: "10.0.2.10" },
    ]);
    // Nothing to deregister
    expect(elbMock.commandCalls(DeregisterTargetsCommand).length).toBe(0);
  });

  it("deregisters stale targets no longer backing the endpoint", async () => {
    ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
      NetworkInterfaces: [{ PrivateIpAddress: "10.0.1.10" }],
    });
    // 10.0.9.9 is stale (not in the current ENI set)
    elbMock.on(DescribeTargetHealthCommand).resolves({
      TargetHealthDescriptions: [
        { Target: { Id: "10.0.1.10" } },
        { Target: { Id: "10.0.9.9" } },
      ],
    });
    elbMock.on(DeregisterTargetsCommand).resolves({});
    elbMock.on(RegisterTargetsCommand).resolves({});

    await handler();

    const deregisterCalls = elbMock.commandCalls(DeregisterTargetsCommand);
    expect(deregisterCalls.length).toBe(2); // one per mapping
    expect(deregisterCalls[0]!.args[0].input.Targets).toEqual([
      { Id: "10.0.9.9" },
    ]);
    // 10.0.1.10 already registered -> no register call
    expect(elbMock.commandCalls(RegisterTargetsCommand).length).toBe(0);
  });

  it("does nothing when target group is already in sync", async () => {
    ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
      NetworkInterfaces: [{ PrivateIpAddress: "10.0.1.10" }],
    });
    elbMock.on(DescribeTargetHealthCommand).resolves({
      TargetHealthDescriptions: [{ Target: { Id: "10.0.1.10" } }],
    });

    await handler();

    expect(elbMock.commandCalls(RegisterTargetsCommand).length).toBe(0);
    expect(elbMock.commandCalls(DeregisterTargetsCommand).length).toBe(0);
  });

  it("throws when a mapping is malformed", async () => {
    vi.stubEnv("ENDPOINT_TARGET_GROUP_MAPPINGS", "not-a-valid-mapping");
    await expect(handler()).rejects.toThrow(/Invalid mapping format/);
  });

  it("throws when any target group sync fails", async () => {
    ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
      NetworkInterfaces: [{ PrivateIpAddress: "10.0.1.10" }],
    });
    elbMock.on(DescribeTargetHealthCommand).rejects(new Error("boom"));

    await expect(handler()).rejects.toThrow(/sync\(s\) failed/);
  });
});
