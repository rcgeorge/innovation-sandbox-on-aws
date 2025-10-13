// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DescribeSecretCommand,
  GetRandomPasswordCommand,
  PutSecretValueCommand,
  UpdateSecretVersionStageCommand,
} from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { handler } from "@amzn/innovation-sandbox-secret-rotator/secret-rotator-handler.js";

vi.mock("@amzn/innovation-sandbox-commons/sdk-clients/index.js", () => {
  const mockSecretsManager = {
    send: vi.fn(),
  };

  return {
    IsbClients: {
      secretsManager: () => mockSecretsManager,
    },
  };
});

const testEnv = generateSchemaData(BaseLambdaEnvironmentSchema);

const mockSecretsManager = vi.mocked(
  (
    await import("@amzn/innovation-sandbox-commons/sdk-clients/index.js")
  ).IsbClients.secretsManager(testEnv),
);

beforeEach(() => {
  bulkStubEnv(testEnv);
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("secret-rotator-handler", () => {
  // Test fixtures - these are dummy values for testing only, not real secrets
  const secretArn =
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:/InnovationSandbox/myisb/Auth/JwtSecret-AAAAAA";
  // gitleaks:allow - Test fixture UUID, not a real token
  const clientRequestToken = "TEST-TOKEN-00000000-0000-0000-0000-000000000000";

  it("should handle a createSecret event", async () => {
    const event = {
      ClientRequestToken: clientRequestToken,
      SecretId: secretArn,
      Step: "createSecret",
    };
    // gitleaks:allow - Mock password for testing only, not a real secret
    const randomPassword = "MOCK-PASSWORD-FOR-TESTING-ONLY-1234";
    mockSecretsManager.send
      .mockImplementationOnce((command: any) => {
        if (command instanceof GetRandomPasswordCommand) {
          return Promise.resolve({
            RandomPassword: randomPassword,
          } as { RandomPassword: string });
        }
      })
      .mockImplementationOnce((command: any) => {
        if (command instanceof PutSecretValueCommand) {
          return Promise.resolve();
        }
      });

    await handler(event, mockContext(testEnv));
    expect(mockSecretsManager.send).toHaveBeenCalledWith(
      expect.any(GetRandomPasswordCommand),
    );
    expect(mockSecretsManager.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          SecretId: secretArn,
          ClientRequestToken: clientRequestToken,
          SecretString: randomPassword,
          VersionStages: ["AWSPENDING"],
        },
      }),
    );
  });

  it("should handle a setSecret event", async () => {
    const event = {
      ClientRequestToken: clientRequestToken,
      SecretId: secretArn,
      Step: "setSecret",
    };

    await handler(event, mockContext(testEnv));
    expect(mockSecretsManager.send).not.toHaveBeenCalled();
  });

  it("should handle a testSecret event", async () => {
    const event = {
      ClientRequestToken: clientRequestToken,
      SecretId: secretArn,
      Step: "testSecret",
    };

    await handler(event, mockContext(testEnv));
    expect(mockSecretsManager.send).not.toHaveBeenCalled();
  });

  it("should handle a finishSecret event", async () => {
    const event = {
      ClientRequestToken: clientRequestToken,
      SecretId: secretArn,
      Step: "finishSecret",
    };
    mockSecretsManager.send
      .mockImplementationOnce((command: any) => {
        if (command instanceof DescribeSecretCommand) {
          return Promise.resolve({
            VersionIdsToStages: {
              versionPending: ["AWSPENDING"],
              versionCurrent: ["AWSCURRENT"],
            },
          });
        }
      })
      .mockImplementationOnce((command: any) => {
        if (command instanceof UpdateSecretVersionStageCommand) {
          return Promise.resolve();
        }
      });

    await handler(event, mockContext(testEnv));
    expect(mockSecretsManager.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { SecretId: secretArn },
      }),
    );

    expect(mockSecretsManager.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          SecretId: secretArn,
          VersionStage: "AWSCURRENT",
          MoveToVersionId: "versionPending",
          RemoveFromVersionId: "versionCurrent",
        },
      }),
    );
  });

  it("should throw an error on invalid event", async () => {
    const event = {
      ClientRequestToken: clientRequestToken,
      SecretId: secretArn,
      Step: "Invalid",
    };
    await expect(handler(event, mockContext(testEnv))).rejects.toThrow(
      "Invalid step",
    );
  });
});
