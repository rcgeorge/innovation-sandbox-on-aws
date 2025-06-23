// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { IdcConfigurerLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/idc-configurer-lambda-environment.js";
import { EnvironmentValidatorError } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import {
  CreateGroupCommand,
  GetGroupIdCommand,
  IdentitystoreClient,
  ResourceNotFoundException as IdentitystoreResourceNotFoundException,
} from "@aws-sdk/client-identitystore";
import {
  AttachManagedPolicyToPermissionSetCommand,
  CreatePermissionSetCommand,
  DescribePermissionSetCommand,
  ListPermissionSetsCommand,
  PermissionSet,
  SSOAdminClient,
  ConflictException as SSOAdminConflictException,
} from "@aws-sdk/client-sso-admin";
import type { CdkCustomResourceEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testEnv = generateSchemaData(IdcConfigurerLambdaEnvironmentSchema);
const identityStoreMock = mockClient(IdentitystoreClient);
const ssoAdminMock = mockClient(SSOAdminClient);
let handler: (typeof import("@amzn/innovation-sandbox-idc-configurer/idc-configurer-handler.js"))["handler"];

// Mock p-throttle to execute immediately in tests
vi.mock("p-throttle", () => ({
  default: () => (fn: any) => fn,
}));

beforeEach(async () => {
  handler = (
    await vi.importActual<
      typeof import("@amzn/innovation-sandbox-idc-configurer/idc-configurer-handler.js")
    >("@amzn/innovation-sandbox-idc-configurer/idc-configurer-handler.js")
  ).handler;
  vi.resetModules();
  bulkStubEnv(testEnv);
  identityStoreMock.reset();
  ssoAdminMock.reset();
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("IDC Configurer Handler", () => {
  const testResourceProperties = {
    namespace: "test-namespace",
    identityStoreId: "test-identity-store-id",
    ssoInstanceArn: "test-sso-instance-arn",
    adminGroupName: "test-admin-group-name",
    managerGroupName: "test-manager-group-name",
    userGroupName: "test-user-group-name",
    solutionVersion: "test-version",
    supportedSchemas: "test-schemas",
  };
  describe("Environment Validation", () => {
    const event: CdkCustomResourceEvent = {
      RequestType: "Create",
      ServiceToken:
        "arn:aws:lambda:us-east-1:111111111111:function:CustomResourceProvider",
      ResponseURL: "https://example.com",
      StackId: "Stack",
      RequestId: "Request",
      LogicalResourceId: "IdcConfigurerIDCCustomResource",
      ResourceType: "Custom::IdcConfigurer",
      ResourceProperties: {
        ServiceToken:
          "arn:aws:lambda:us-east-1:111111111111:function:CustomResourceProvider",
        ...testResourceProperties,
      },
    };
    it("should throw error when environment variables are misconfigured", async () => {
      vi.unstubAllEnvs();
      await expect(handler(event, mockContext(testEnv))).rejects.toThrow(
        EnvironmentValidatorError,
      );
    });
  });

  describe.each([{ requestType: "Create" }, { requestType: "Update" }])(
    "$requestType Operations",
    ({ requestType }) => {
      const event: CdkCustomResourceEvent = {
        RequestType: requestType as any,
        ServiceToken:
          "arn:aws:lambda:us-east-1:111111111111:function:CustomResourceProvider",
        ResponseURL: "https://example.com",
        StackId: "Stack",
        RequestId: "Request",
        LogicalResourceId: "IdcConfigurerIDCCustomResource",
        ResourceType: "Custom::IdcConfigurer",
        ResourceProperties: {
          ServiceToken:
            "arn:aws:lambda:us-east-1:111111111111:function:CustomResourceProvider",
          ...testResourceProperties,
        },
      };
      describe("Group Management", () => {
        it("should create new groups when they don't exist", async () => {
          // Mock group operations
          identityStoreMock.on(GetGroupIdCommand).rejects(
            new IdentitystoreResourceNotFoundException({
              message: "Group not found",
              $metadata: {},
            }),
          );
          identityStoreMock.on(CreateGroupCommand).callsFake((input) => {
            const groupIdMap = {
              [testResourceProperties.adminGroupName]: "admin-group-id",
              [testResourceProperties.managerGroupName]: "manager-group-id",
              [testResourceProperties.userGroupName]: "user-group-id",
            };
            return { GroupId: groupIdMap[input.DisplayName] };
          });

          ssoAdminMock.on(CreatePermissionSetCommand).resolves({
            PermissionSet: {
              PermissionSetArn: "test-arn",
            },
          });
          ssoAdminMock
            .on(AttachManagedPolicyToPermissionSetCommand)
            .resolves({});

          const response = await handler(event, mockContext(testEnv));

          // Verify the response data structure
          expect(response.Data).toMatchObject({
            adminGroupId: "admin-group-id",
            managerGroupId: "manager-group-id",
            userGroupId: "user-group-id",
          });

          // Verify group creation calls
          const createGroupCalls =
            identityStoreMock.commandCalls(CreateGroupCommand);
          expect(createGroupCalls).toHaveLength(3);

          // Verify admin group creation
          expect(createGroupCalls[0]?.args[0].input).toMatchObject({
            DisplayName: testResourceProperties.adminGroupName,
            IdentityStoreId: testResourceProperties.identityStoreId,
            Description: expect.stringContaining("Admin UserGroup"),
          });

          // Verify manager group creation
          expect(createGroupCalls[1]?.args[0].input).toMatchObject({
            DisplayName: testResourceProperties.managerGroupName,
            IdentityStoreId: testResourceProperties.identityStoreId,
            Description: expect.stringContaining("Manager UserGroup"),
          });

          // Verify user group creation
          expect(createGroupCalls[2]?.args[0].input).toMatchObject({
            DisplayName: testResourceProperties.userGroupName,
            IdentityStoreId: testResourceProperties.identityStoreId,
            Description: expect.stringContaining("User UserGroup"),
          });
        });

        it("should truncate group name if it exceeds 128 characters", async () => {
          const longName = "a".repeat(150);
          const truncatedName = "a".repeat(128);

          identityStoreMock.on(GetGroupIdCommand).rejects(
            new IdentitystoreResourceNotFoundException({
              message: "Group not found",
              $metadata: {},
            }),
          );
          identityStoreMock.on(CreateGroupCommand).resolves({
            GroupId: "new-group-id",
          });

          const eventWithLongNamespace = {
            ...event,
            ResourceProperties: {
              ...event.ResourceProperties,
              adminGroupName: longName,
            },
          };

          // Mock permission set operations
          ssoAdminMock.on(CreatePermissionSetCommand).resolves({
            PermissionSet: {
              PermissionSetArn: "test-arn",
            },
          });

          await handler(eventWithLongNamespace, mockContext(testEnv));

          // Verify GetGroupIdCommand was called with truncated name
          expect(
            identityStoreMock.commandCalls(GetGroupIdCommand)[0]?.args[0].input,
          ).toMatchObject({
            IdentityStoreId: testResourceProperties.identityStoreId,
            AlternateIdentifier: {
              UniqueAttribute: {
                AttributePath: "DisplayName",
                AttributeValue: truncatedName,
              },
            },
          });

          // Verify CreateGroupCommand was called with truncated name
          expect(
            identityStoreMock.commandCalls(CreateGroupCommand)[0]?.args[0]
              .input,
          ).toMatchObject({
            DisplayName: truncatedName,
            IdentityStoreId: testResourceProperties.identityStoreId,
            Description: expect.any(String),
          });
        });

        it("should reuse existing groups", async () => {
          // Mock existing groups
          identityStoreMock.on(GetGroupIdCommand).callsFake((input) => {
            const groupMap = {
              [testResourceProperties.adminGroupName]: "existing-admin-group",
              [testResourceProperties.managerGroupName]:
                "existing-manager-group",
              [testResourceProperties.userGroupName]: "existing-user-group",
            };
            const groupId =
              groupMap[
                input.AlternateIdentifier?.UniqueAttribute?.AttributeValue || ""
              ];
            return Promise.resolve({ GroupId: groupId });
          });

          // Mock permission set operations
          ssoAdminMock.on(CreatePermissionSetCommand).resolves({
            PermissionSet: {
              PermissionSetArn: "test-arn",
            },
          });

          const response = await handler(event, mockContext(testEnv));

          // Verify the response data structure with existing group IDs
          expect(response.Data).toMatchObject({
            adminGroupId: "existing-admin-group",
            managerGroupId: "existing-manager-group",
            userGroupId: "existing-user-group",
          });

          // Verify existing groups were found and reused
          expect(
            identityStoreMock.commandCalls(CreateGroupCommand),
          ).toHaveLength(0);

          // Verify GetGroupId was called for each group
          const getGroupCalls =
            identityStoreMock.commandCalls(GetGroupIdCommand);
          expect(getGroupCalls).toHaveLength(3);
          expect(getGroupCalls[0]?.args[0].input).toMatchObject({
            IdentityStoreId: testResourceProperties.identityStoreId,
            AlternateIdentifier: {
              UniqueAttribute: {
                AttributePath: "DisplayName",
                AttributeValue: testResourceProperties.adminGroupName,
              },
            },
          });
          expect(getGroupCalls[1]?.args[0].input).toMatchObject({
            IdentityStoreId: testResourceProperties.identityStoreId,
            AlternateIdentifier: {
              UniqueAttribute: {
                AttributePath: "DisplayName",
                AttributeValue: testResourceProperties.managerGroupName,
              },
            },
          });
          expect(getGroupCalls[2]?.args[0].input).toMatchObject({
            IdentityStoreId: testResourceProperties.identityStoreId,
            AlternateIdentifier: {
              UniqueAttribute: {
                AttributePath: "DisplayName",
                AttributeValue: testResourceProperties.userGroupName,
              },
            },
          });
        });
      });

      describe("Permission Set Management", () => {
        it("should create new permission sets when they don't exist", async () => {
          // Mock group operations
          identityStoreMock.on(GetGroupIdCommand).rejects(
            new IdentitystoreResourceNotFoundException({
              message: "Group not found",
              $metadata: {},
            }),
          );
          identityStoreMock.on(CreateGroupCommand).resolves({
            GroupId: "new-group-id",
          });

          // Mock empty existing permission sets
          ssoAdminMock.on(CreatePermissionSetCommand).resolves({
            PermissionSet: {
              PermissionSetArn: "test-arn",
            },
          });

          const response = await handler(event, mockContext(testEnv));

          // Verify permission sets were created
          const createPSCalls = ssoAdminMock.commandCalls(
            CreatePermissionSetCommand,
          );
          expect(createPSCalls).toHaveLength(3);

          // Verify admin permission set creation
          expect(createPSCalls[0]?.args[0].input).toMatchObject({
            Name: `${testResourceProperties.namespace}_IsbAdminsPS`,
            Description: expect.stringContaining("Admin PermissionSet"),
            InstanceArn: testResourceProperties.ssoInstanceArn,
          });

          // Verify manager permission set creation
          expect(createPSCalls[1]?.args[0].input).toMatchObject({
            Name: `${testResourceProperties.namespace}_IsbManagersPS`,
            Description: expect.stringContaining("Manager PermissionSet"),
            InstanceArn: testResourceProperties.ssoInstanceArn,
          });

          // Verify user permission set creation
          expect(createPSCalls[2]?.args[0].input).toMatchObject({
            Name: `${testResourceProperties.namespace}_IsbUsersPS`,
            Description: expect.stringContaining("User PermissionSet"),
            InstanceArn: testResourceProperties.ssoInstanceArn,
          });

          // Verify response data contains permission set ARNs
          expect(response.Data).toMatchObject({
            adminPermissionSetArn: "test-arn",
            managerPermissionSetArn: "test-arn",
            userPermissionSetArn: "test-arn",
          });
        });

        it("should handle paginated permission set listings", async () => {
          // Mock group operations
          identityStoreMock.on(GetGroupIdCommand).rejects(
            new IdentitystoreResourceNotFoundException({
              message: "Group not found",
              $metadata: {},
            }),
          );
          identityStoreMock.on(CreateGroupCommand).resolves({
            GroupId: "new-group-id",
          });

          // Mock existing permission sets
          const existingPS: PermissionSet[] = [
            {
              Name: `${testResourceProperties.namespace}_IsbAdminsPS`,
              PermissionSetArn: "arn:admin",
            },
            {
              Name: `${testResourceProperties.namespace}_IsbManagersPS`,
              PermissionSetArn: "arn:manager",
            },
            {
              Name: `${testResourceProperties.namespace}_IsbUsersPS`,
              PermissionSetArn: "arn:user",
            },
          ];

          // Mock permission set creation to fail with conflict
          ssoAdminMock.on(CreatePermissionSetCommand).rejects(
            new SSOAdminConflictException({
              message: "PermissionSet with this name already exists",
              $metadata: {},
            }),
          );

          // Mock list and describe operations
          ssoAdminMock
            .on(ListPermissionSetsCommand)
            .resolvesOnce({
              PermissionSets: [
                existingPS[0]?.PermissionSetArn!,
                existingPS[1]?.PermissionSetArn!,
              ],
              NextToken: "token1",
            })
            .resolvesOnce({
              PermissionSets: [existingPS[2]?.PermissionSetArn!],
            });
          ssoAdminMock.on(DescribePermissionSetCommand).callsFake((input) => {
            const ps = existingPS.find(
              (p) => p.PermissionSetArn === input.PermissionSetArn,
            );
            return Promise.resolve({
              PermissionSet: ps,
            });
          });

          const response = await handler(event, mockContext(testEnv));

          // Verify response data structure
          expect(response.Data).toMatchObject({
            adminPermissionSetArn: "arn:admin",
            managerPermissionSetArn: "arn:manager",
            userPermissionSetArn: "arn:user",
          });

          // Verify first page request
          const listPSCalls = ssoAdminMock.commandCalls(
            ListPermissionSetsCommand,
          );
          expect(listPSCalls[0]?.args[0].input).toMatchObject({
            InstanceArn: testResourceProperties.ssoInstanceArn,
          });

          // Verify second page request
          expect(listPSCalls[1]?.args[0].input).toMatchObject({
            InstanceArn: testResourceProperties.ssoInstanceArn,
            NextToken: "token1",
          });

          // Verify permission set descriptions
          const describeCalls = ssoAdminMock.commandCalls(
            DescribePermissionSetCommand,
          );
          const permissionSetArns = existingPS.map(
            (ps) => ps.PermissionSetArn!,
          );
          permissionSetArns.forEach((psArn, index) => {
            expect(describeCalls[index]?.args[0].input).toMatchObject({
              InstanceArn: testResourceProperties.ssoInstanceArn,
              PermissionSetArn: psArn,
            });
          });

          // Verify total number of describe calls
          expect(
            ssoAdminMock.commandCalls(DescribePermissionSetCommand),
          ).toHaveLength(3);
        });

        it("should truncate permission set name if it exceeds 32 characters", async () => {
          // Mock group operations
          identityStoreMock.on(GetGroupIdCommand).rejects(
            new IdentitystoreResourceNotFoundException({
              message: "Group not found",
              $metadata: {},
            }),
          );
          identityStoreMock.on(CreateGroupCommand).resolves({
            GroupId: "new-group-id",
          });

          // Mock permission set operations
          ssoAdminMock.on(CreatePermissionSetCommand).resolves({
            PermissionSet: {
              PermissionSetArn: "test-arn",
            },
          });
          ssoAdminMock
            .on(AttachManagedPolicyToPermissionSetCommand)
            .resolves({});

          const eventWithLongNamespace = {
            ...event,
            ResourceProperties: {
              ...event.ResourceProperties,
              namespace: "a".repeat(50),
            },
          };

          await handler(eventWithLongNamespace, mockContext(testEnv));

          // Verify the permission set was created with truncated name
          expect(
            ssoAdminMock.commandCalls(CreatePermissionSetCommand)[0]?.args[0]
              .input,
          ).toMatchObject({
            Name: "a".repeat(32),
            Description: expect.any(String),
            InstanceArn: testResourceProperties.ssoInstanceArn,
          });
        });

        it("should reuse existing permission sets", async () => {
          // Mock group operations
          identityStoreMock.on(GetGroupIdCommand).rejects(
            new IdentitystoreResourceNotFoundException({
              message: "Group not found",
              $metadata: {},
            }),
          );
          identityStoreMock.on(CreateGroupCommand).resolves({
            GroupId: "new-group-id",
          });

          // Mock permission set creation to fail with conflict
          ssoAdminMock.on(CreatePermissionSetCommand).rejects(
            new SSOAdminConflictException({
              message: "PermissionSet with this name already exists",
              $metadata: {},
            }),
          );

          // Mock existing permission sets
          const existingPS: PermissionSet[] = [
            {
              Name: `${testResourceProperties.namespace}_IsbAdminsPS`,
              PermissionSetArn: "arn:admin",
            },
            {
              Name: `${testResourceProperties.namespace}_IsbManagersPS`,
              PermissionSetArn: "arn:manager",
            },
            {
              Name: `${testResourceProperties.namespace}_IsbUsersPS`,
              PermissionSetArn: "arn:user",
            },
          ];

          // Mock list and describe operations
          ssoAdminMock.on(ListPermissionSetsCommand).resolves({
            PermissionSets: existingPS.map((ps) => ps.PermissionSetArn!),
          });
          ssoAdminMock.on(DescribePermissionSetCommand).callsFake((input) => {
            const ps = existingPS.find(
              (p) => p.PermissionSetArn === input.PermissionSetArn,
            );
            return Promise.resolve({
              PermissionSet: ps,
            });
          });

          const response = await handler(event, mockContext(testEnv));
          expect(response.Data).toMatchObject({
            adminPermissionSetArn: "arn:admin",
            managerPermissionSetArn: "arn:manager",
            userPermissionSetArn: "arn:user",
          });
        });

        it("should attach admin policy to new permission sets", async () => {
          // Mock group operations
          identityStoreMock.on(GetGroupIdCommand).rejects(
            new IdentitystoreResourceNotFoundException({
              message: "Group not found",
              $metadata: {},
            }),
          );
          identityStoreMock.on(CreateGroupCommand).resolves({
            GroupId: "new-group-id",
          });

          // Mock permission set operations
          ssoAdminMock.on(CreatePermissionSetCommand).resolves({
            PermissionSet: {
              PermissionSetArn: "test-arn",
            },
          });
          ssoAdminMock
            .on(AttachManagedPolicyToPermissionSetCommand)
            .resolves({});

          await handler(event, mockContext(testEnv));

          // Verify admin policy was attached to each permission set
          const attachPolicyCalls = ssoAdminMock.commandCalls(
            AttachManagedPolicyToPermissionSetCommand,
          );
          expect(attachPolicyCalls).toHaveLength(3);

          // Verify each policy attachment
          ["test-arn", "test-arn", "test-arn"].forEach((arn, index) => {
            expect(attachPolicyCalls[index]?.args[0].input).toMatchObject({
              InstanceArn: testResourceProperties.ssoInstanceArn,
              PermissionSetArn: arn,
              ManagedPolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
            });
          });
        });
      });

      describe("Error Handling", () => {
        it("should handle errors thrown while creating resources", async () => {
          identityStoreMock.on(GetGroupIdCommand).rejects(
            new IdentitystoreResourceNotFoundException({
              message: "Group not found",
              $metadata: {},
            }),
          );
          identityStoreMock
            .on(CreateGroupCommand)
            .rejectsOnce(new Error("TestException"));

          // Mock permission set operations
          ssoAdminMock.on(CreatePermissionSetCommand).resolves({
            PermissionSet: {
              PermissionSetArn: "test-arn",
            },
          });
          ssoAdminMock
            .on(AttachManagedPolicyToPermissionSetCommand)
            .resolves({});

          await expect(handler(event, mockContext(testEnv))).rejects.toThrow(
            "TestException",
          );
        });
      });
    },
  );

  describe("Delete Operations", () => {
    it("should retain resources on delete", async () => {
      const deleteEvent: CdkCustomResourceEvent = {
        RequestType: "Delete",
        ServiceToken:
          "arn:aws:lambda:us-east-1:111111111111:function:CustomResourceProvider",
        ResponseURL: "https://example.com",
        StackId: "Stack",
        RequestId: "Request",
        LogicalResourceId: "IdcConfigurerIDCCustomResource",
        PhysicalResourceId: "test-resource",
        ResourceType: "Custom::IdcConfigurer",
        ResourceProperties: {
          ServiceToken:
            "arn:aws:lambda:us-east-1:111111111111:function:CustomResourceProvider",
          ...testResourceProperties,
        },
      };

      const response = await handler(deleteEvent, mockContext(testEnv));
      expect(response.Data).toEqual({
        status: "IDC groups and permission sets retained",
      });

      // Verify no delete operations were attempted
      expect(identityStoreMock.calls()).toHaveLength(0);
      expect(ssoAdminMock.calls()).toHaveLength(0);
    });
  });
});
