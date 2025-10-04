// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import {
  addParameterGroup,
  OptionalParameter,
  ParameterWithLabel,
} from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import { HubAccountIdParam } from "@amzn/innovation-sandbox-infrastructure/helpers/hub-account-id-param";
import { NamespaceParam } from "@amzn/innovation-sandbox-infrastructure/helpers/namespace-param";
import { applyIsbTag } from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";
import { IsbIdcResources } from "@amzn/innovation-sandbox-infrastructure/isb-idc-resources";

export interface IsbIdcStackProps extends StackProps {
  adminGroupName?: string;
  managerGroupName?: string;
  userGroupName?: string;
}

export class IsbIdcStack extends Stack {
  constructor(scope: Construct, id: string, props?: IsbIdcStackProps) {
    super(scope, id, props);

    const namespaceParam = new NamespaceParam(this);
    const hubAccountIdParam = new HubAccountIdParam(this);

    const identityStoreId = new ParameterWithLabel(this, "IdentityStoreId", {
      label: "Identity Store Id",
      description:
        "The Identity Store Id of the Identity Source in IAM Identity Center (d-xxxxxxxxxx)",
      allowedPattern:
        "^d-[0-9a-f]{10}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    });

    const ssoInstanceArn = new ParameterWithLabel(this, "SsoInstanceArn", {
      label: "SSO Instance ARN",
      description:
        "The ARN of the SSO instance in IAM Identity Center (e.g., arn:aws:sso:::instance/ssoins-xxxxxxxxxxxxxxxx or arn:aws-us-gov:sso:::instance/ssoins-xxxxxxxxxxxxxxxx)",
      allowedPattern: "^arn:aws(-us-gov)?:sso:::instance/(sso)?ins-[a-zA-Z0-9-.]{16}$",
    });

    const idcRegion = new ParameterWithLabel(this, "IdcRegion", {
      label: "IDC Region",
      description:
        "The AWS region where IAM Identity Center is deployed (e.g., us-east-1, us-gov-west-1)",
      allowedPattern: "^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$",
    });

    const idcKmsKeyArn = new ParameterWithLabel(this, "IdcKmsKeyArn", {
      label: "IDC KMS Key ARN",
      description:
        "The ARN of the KMS key used by IAM Identity Center for encryption (e.g., arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012). Use 'AWS_OWNED_KEY' if using AWS owned key.",
      allowedPattern: "^(AWS_OWNED_KEY|arn:aws(-us-gov)?:kms:[a-z0-9-]+:\\d{12}:key/[a-f0-9-]+)$",
    });

    const adminGroupName = new OptionalParameter(this, "AdminGroupName", {
      label: "Admin Group Name (Optional)",
      description:
        "A custom name to provide for the admin group (value if left empty: <namespace>_IsbAdminsGroup).",
      valueIfEmpty: `${namespaceParam.namespace.valueAsString}_IsbAdminsGroup`,
    });

    const managerGroupName = new OptionalParameter(this, "ManagerGroupName", {
      label: "Manager Group Name (Optional)",
      description:
        "A custom name to provide for the manager group (value if left empty: <namespace>_IsbManagersGroup).",
      valueIfEmpty: `${namespaceParam.namespace.valueAsString}_IsbManagersGroup`,
    });

    const userGroupName = new OptionalParameter(this, "UserGroupName", {
      label: "User Group Name (Optional)",
      description:
        "A custom name to provide for the user group (value if left empty: <namespace>_IsbUsersGroup).",
      valueIfEmpty: `${namespaceParam.namespace.valueAsString}_IsbUsersGroup`,
    });

    addParameterGroup(this, {
      label: "IDC Stack Configuration",
      parameters: [
        namespaceParam.namespace,
        hubAccountIdParam.hubAccountId,
        identityStoreId,
        ssoInstanceArn,
        idcRegion,
        idcKmsKeyArn,
        adminGroupName,
        managerGroupName,
        userGroupName,
      ],
    });

    new IsbIdcResources(this, {
      hubAccountId: hubAccountIdParam.hubAccountId.valueAsString,
      identityStoreId: identityStoreId.valueAsString,
      ssoInstanceArn: ssoInstanceArn.valueAsString,
      idcRegion: idcRegion.valueAsString,
      idcKmsKeyArn: idcKmsKeyArn.valueAsString,
      adminGroupName: adminGroupName.resolve(),
      managerGroupName: managerGroupName.resolve(),
      userGroupName: userGroupName.resolve(),
      namespace: namespaceParam.namespace.valueAsString,
      solutionVersion: getContextFromMapping(this, "version"),
    });

    applyIsbTag(this, `${namespaceParam.namespace.valueAsString}`);
  }
}
