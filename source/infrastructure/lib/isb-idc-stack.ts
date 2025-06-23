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
        "The ARN of the SSO instance in IAM Identity Center (arn:aws:sso:::instance/ssoins-xxxxxxxxxxxxxxxx)",
      allowedPattern: "^arn:aws:sso:::instance/(sso)?ins-[a-zA-Z0-9-.]{16}$",
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
        adminGroupName,
        managerGroupName,
        userGroupName,
      ],
    });

    new IsbIdcResources(this, {
      hubAccountId: hubAccountIdParam.hubAccountId.valueAsString,
      identityStoreId: identityStoreId.valueAsString,
      ssoInstanceArn: ssoInstanceArn.valueAsString,
      adminGroupName: adminGroupName.resolve(),
      managerGroupName: managerGroupName.resolve(),
      userGroupName: userGroupName.resolve(),
      namespace: namespaceParam.namespace.valueAsString,
      solutionVersion: getContextFromMapping(this, "version"),
    });

    applyIsbTag(this, `${namespaceParam.namespace.valueAsString}`);
  }
}
