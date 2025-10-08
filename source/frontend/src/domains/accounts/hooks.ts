// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AccountService } from "@amzn/innovation-sandbox-frontend/domains/accounts/service";

export const useGetAccounts = () => {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: async () => await new AccountService().getAccounts(),
  });
};

export const useGetUnregisteredAccounts = () => {
  return useQuery({
    queryKey: ["unregisteredAccounts"],
    queryFn: async () => await new AccountService().getUnregisteredAccounts(),
  });
};

export const useAddAccount = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (awsAccountId: string) =>
      await new AccountService().addAccount(awsAccountId),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["accounts"], refetchType: "all" });
      client.invalidateQueries({
        queryKey: ["unregisteredAccounts"],
        refetchType: "all",
      });
    },
  });
};

export const useEjectAccount = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (awsAccountId: string) =>
      await new AccountService().ejectAccount(awsAccountId),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["accounts"], refetchType: "all" });
      client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
    },
  });
};

export const useCleanupAccount = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (awsAccountId: string) =>
      await new AccountService().cleanupAccount(awsAccountId),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["accounts"], refetchType: "all" }),
  });
};

export const useCreateGovCloudAccount = () => {
  return useMutation({
    mutationFn: async (params:
      | { mode: "create"; accountName: string; email: string }
      | { mode: "join-existing"; govCloudAccountId: string; commercialAccountId: string; accountName: string }
    ) => await new AccountService().createGovCloudAccount(params),
  });
};

export const useGetGovCloudAccountStatus = (executionId: string | null, enabled: boolean = true) => {
  const client = useQueryClient();
  return useQuery({
    queryKey: ["govCloudAccountStatus", executionId],
    queryFn: async () => {
      if (!executionId) throw new Error("No execution ID");
      return await new AccountService().getGovCloudAccountStatus(executionId);
    },
    enabled: enabled && !!executionId,
    refetchInterval: (query) => {
      // Stop polling if status is terminal (SUCCEEDED, FAILED, TIMED_OUT, ABORTED)
      const data = query.state.data;
      if (data?.status && ["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"].includes(data.status)) {
        // Invalidate accounts when succeeded
        if (data.status === "SUCCEEDED") {
          client.invalidateQueries({ queryKey: ["accounts"], refetchType: "all" });
          client.invalidateQueries({
            queryKey: ["unregisteredAccounts"],
            refetchType: "all",
          });
          client.invalidateQueries({
            queryKey: ["availableGovCloudAccounts"],
            refetchType: "all",
          });
        }
        return false;
      }
      return 5000; // Poll every 5 seconds
    },
  });
};

export const useGetAvailableGovCloudAccounts = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ["availableGovCloudAccounts"],
    queryFn: async () => await new AccountService().getAvailableGovCloudAccounts(),
    enabled,
    staleTime: 30000, // Cache for 30 seconds
  });
};
