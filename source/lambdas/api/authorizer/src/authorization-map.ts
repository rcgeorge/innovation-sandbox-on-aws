// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { IsbRole } from "@amzn/innovation-sandbox-commons/types/isb-types.js";

export type HttpMethod =
  | "OPTIONS"
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "TRACE"
  | "CONNECT"
  | "ALL";

interface AuthorizationMapType {
  [path: string]: {
    [method in HttpMethod]?: IsbRole[];
  };
}

export const authorizationMap: AuthorizationMapType = {
  "/leases": {
    GET: ["Manager", "Admin", "User"],
    POST: ["User", "Manager", "Admin"],
  },
  "/leases/{param}": {
    PATCH: ["Manager", "Admin"],
    GET: ["User", "Manager", "Admin"],
  },
  "/leases/{param}/review": {
    POST: ["Manager", "Admin"],
  },
  "/leases/{param}/terminate": {
    POST: ["Manager", "Admin"],
  },
  "/leases/{param}/freeze": {
    POST: ["Manager", "Admin"],
  },
  "/leaseTemplates": {
    GET: ["User", "Manager", "Admin"],
    POST: ["Admin", "Manager"],
  },
  "/leaseTemplates/{param}": {
    GET: ["User", "Manager", "Admin"],
    DELETE: ["Admin", "Manager"],
    PUT: ["Admin", "Manager"],
  },
  "/configurations": {
    GET: ["Manager", "Admin", "User"],
    POST: ["Admin"],
  },
  "/accounts": {
    GET: ["Admin"],
    POST: ["Admin"],
  },
  "/accounts/{param}": {
    GET: ["Admin"],
  },
  "/accounts/{param}/retryCleanup": {
    POST: ["Admin"],
  },
  "/accounts/{param}/eject": {
    POST: ["Admin"],
  },
  "/accounts/unregistered": {
    GET: ["Admin"],
  },
  "/accounts/govcloud/create": {
    POST: ["Admin"],
  },
  "/accounts/govcloud/create/status/{param}": {
    GET: ["Admin"],
  },
  "/accounts/govcloud/available": {
    GET: ["Admin"],
  },
  "/users": {
    GET: ["Admin", "Manager"],
  },
};
