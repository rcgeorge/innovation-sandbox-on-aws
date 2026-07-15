// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  ElasticLoadBalancingV2Client,
  ModifyRuleCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type { CdkCustomResourceEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { handler } from "@amzn/innovation-sandbox-endpoint-eni-sync/apply-rule-transforms-handler.js";

const elbMock = mockClient(ElasticLoadBalancingV2Client);

const SPA_RULE = "arn:aws:elasticloadbalancing:us-gov-west-1:111:listener-rule/spa";
const API_RULE = "arn:aws:elasticloadbalancing:us-gov-west-1:111:listener-rule/api";

const resourceProperties = {
  ServiceToken: "token",
  SpaRuleArn: SPA_RULE,
  S3EndpointHost: "bucket.s3.us-gov-west-1.amazonaws.com",
  ApiRuleArn: API_RULE,
  ApiGatewayHost: "abc123.execute-api.us-gov-west-1.amazonaws.com",
  ApiStage: "prod",
};

function makeEvent(
  requestType: "Create" | "Update" | "Delete",
  props: Record<string, string> = resourceProperties,
): CdkCustomResourceEvent {
  return {
    LogicalResourceId: "ApplyRuleTransforms",
    RequestId: "req",
    RequestType: requestType,
    ResourceProperties: props,
    ResourceType: "Custom::AlbRuleTransforms",
    ResponseURL: "url",
    ServiceToken: "token",
    StackId: "stack",
    ...(requestType !== "Create"
      ? { PhysicalResourceId: "existing-id" }
      : {}),
    ...(requestType === "Update" ? { OldResourceProperties: props } : {}),
  } as CdkCustomResourceEvent;
}

beforeEach(() => {
  elbMock.reset();
  elbMock.on(ModifyRuleCommand).resolves({});
});

describe("apply-rule-transforms handler", () => {
  it("applies host + url transforms to both SPA and API rules on Create", async () => {
    await handler(makeEvent("Create"));

    const calls = elbMock.commandCalls(ModifyRuleCommand);
    expect(calls.length).toBe(2);

    const byRule = Object.fromEntries(
      calls.map((c) => [c.args[0].input.RuleArn, c.args[0].input.Transforms]),
    );

    // SPA rule: host -> S3, extensionless -> /index.html
    expect(byRule[SPA_RULE]).toEqual([
      {
        Type: "host-header-rewrite",
        HostHeaderRewriteConfig: {
          Rewrites: [
            { Regex: "^.*$", Replace: "bucket.s3.us-gov-west-1.amazonaws.com" },
          ],
        },
      },
      {
        Type: "url-rewrite",
        UrlRewriteConfig: {
          Rewrites: [{ Regex: "^/[^.]*$", Replace: "/index.html" }],
        },
      },
    ]);

    // API rule: host -> execute-api, strip /api and inject stage
    expect(byRule[API_RULE]).toEqual([
      {
        Type: "host-header-rewrite",
        HostHeaderRewriteConfig: {
          Rewrites: [
            {
              Regex: "^.*$",
              Replace: "abc123.execute-api.us-gov-west-1.amazonaws.com",
            },
          ],
        },
      },
      {
        Type: "url-rewrite",
        UrlRewriteConfig: {
          Rewrites: [{ Regex: "^/api/(.*)$", Replace: "/prod/$1" }],
        },
      },
    ]);
  });

  it("applies transforms on Update", async () => {
    await handler(makeEvent("Update"));
    expect(elbMock.commandCalls(ModifyRuleCommand).length).toBe(2);
  });

  it("does nothing on Delete", async () => {
    const res = await handler(makeEvent("Delete"));
    expect(elbMock.commandCalls(ModifyRuleCommand).length).toBe(0);
    expect(res.PhysicalResourceId).toBe("existing-id");
  });

  it("throws when required properties are missing", async () => {
    const { ApiGatewayHost: _omit, ...partial } = resourceProperties;
    await expect(handler(makeEvent("Create", partial))).rejects.toThrow(
      /Missing required ResourceProperties/,
    );
  });
});
