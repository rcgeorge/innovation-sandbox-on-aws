// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  FormField,
  Input,
  Modal,
  RadioGroup,
  SpaceBetween,
  Spinner,
} from "@cloudscape-design/components";
import { useEffect, useState } from "react";

import { BatchActionReview } from "@amzn/innovation-sandbox-frontend/components/MultiSelectTableActionReview";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  useAddAccount,
  useCreateGovCloudAccount,
  useGetAvailableGovCloudAccounts,
  useGetGovCloudAccountStatus,
  useGetUnregisteredAccounts,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/hooks";
import { UnregisteredAccount } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { Table } from "@aws-northstar/ui";
import { useNavigate } from "react-router-dom";

export const AddAccounts = () => {
  const setBreadcrumb = useBreadcrumb();
  const navigate = useNavigate();
  const {
    data: unregisteredAccounts,
    isLoading: getUnregisteredAccountsIsLoading,
    isFetching: getUnregisteredAccountsIsFetching,
    refetch,
  } = useGetUnregisteredAccounts();

  const { mutateAsync: addAccount } = useAddAccount();
  const { mutateAsync: createGovCloudAccount, isPending: isCreatingAccount } =
    useCreateGovCloudAccount();

  const [selectedAccounts, setSelectedAccounts] = useState<
    UnregisteredAccount[]
  >([]);
  const [showCreateAccountModal, setShowCreateAccountModal] = useState(false);
  const [mode, setMode] = useState<"create" | "join-existing">("create");
  const [accountName, setAccountName] = useState("");
  const [email, setEmail] = useState("");
  const [selectedGovCloudAccount, setSelectedGovCloudAccount] = useState<any>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);

  const { data: availableGovCloudAccounts, isLoading: isLoadingAvailable, refetch: refetchAvailable } =
    useGetAvailableGovCloudAccounts(true); // Always enabled so invalidation triggers refetch

  // Poll for GovCloud account creation status
  const { data: statusData } = useGetGovCloudAccountStatus(
    executionId,
    !!executionId
  );

  const { showModal } = useModal();

  // Refetch available accounts when switching to join-existing mode
  useEffect(() => {
    if (showCreateAccountModal && mode === "join-existing") {
      refetchAvailable();
    }
  }, [showCreateAccountModal, mode, refetchAvailable]);

  // Debug: Log available accounts and status
  useEffect(() => {
    console.log("Available GovCloud Accounts:", availableGovCloudAccounts);
  }, [availableGovCloudAccounts]);

  useEffect(() => {
    console.log("Execution ID:", executionId, "Status Data:", statusData);
  }, [executionId, statusData]);

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Accounts", href: "/accounts" },
      { text: "Add Accounts", href: "/accounts/new" },
    ]);
  }, []);

  const showRegisterModal = () =>
    showModal({
      header: "Review Accounts to Register",
      content: (
        <BatchActionReview
          items={selectedAccounts}
          description={`${selectedAccounts.length} account(s) will be added to the account pool`}
          columnDefinitions={columnDefinitions}
          identifierKey="Id"
          footer={
            <Alert type="warning" header="Warning">
              The accounts listed above will be nuked meaning all resources in
              the account will be deleted permanently.
              <br />
              This action cannot be undone!
            </Alert>
          }
          onSubmit={async (account: UnregisteredAccount) => {
            await addAccount(account.Id);
          }}
          onSuccess={() => {
            navigate("/accounts");
            showSuccessToast(
              "Accounts were successfully registered with the solution and are now in cleanup.",
            );
          }}
          onError={() =>
            showErrorToast(
              "One or more accounts failed to register, try resubmitting registration.",
              "Failed to register accounts",
            )
          }
        />
      ),
      size: "max",
    });

  const handleCreateGovCloudAccount = async () => {
    try {
      const params = mode === "create"
        ? { mode: "create" as const, accountName, email }
        : {
            mode: "join-existing" as const,
            govCloudAccountId: selectedGovCloudAccount.govCloudAccountId,
            commercialAccountId: selectedGovCloudAccount.commercialAccountId,
            accountName: selectedGovCloudAccount.accountName,
          };

      const result = await createGovCloudAccount(params);
      // Store execution ID to start polling
      setExecutionId(result.executionId);
      // Don't show toast - modal will show progress
    } catch (error) {
      showErrorToast(
        error instanceof Error ? error.message : "Failed to start workflow",
        "Workflow Failed",
      );
    }
  };

  const resetForm = () => {
    setShowCreateAccountModal(false);
    setMode("create");
    setAccountName("");
    setEmail("");
    setSelectedGovCloudAccount(null);
  };

  // Handle status updates
  useEffect(() => {
    if (statusData?.status === "SUCCEEDED" && statusData.result) {
      resetForm();
      setExecutionId(null);
      navigate("/accounts");
      showSuccessToast(
        `GovCloud account workflow completed! GovCloud ID: ${statusData.result.govCloudAccountId}, Commercial ID: ${statusData.result.commercialAccountId}`,
      );
    } else if (statusData?.status === "FAILED") {
      setExecutionId(null);
      showErrorToast(
        "Workflow failed. Check Step Function logs for details.",
        "Workflow Failed",
      );
    } else if (statusData?.status === "TIMED_OUT") {
      setExecutionId(null);
      showErrorToast(
        "Workflow timed out. Check Step Function logs for details.",
        "Workflow Timed Out",
      );
    } else if (statusData?.status === "ABORTED") {
      setExecutionId(null);
      showErrorToast(
        "Workflow was aborted.",
        "Workflow Aborted",
      );
    }
  }, [statusData, navigate]);

  const columnDefinitions = [
    {
      cell: (account: UnregisteredAccount) => account.Id,
      header: "AWS Account ID",
      id: "Id",
    },
    {
      cell: (account: UnregisteredAccount) => account.Email,
      header: "Email",
      id: "Email",
    },
    {
      cell: (account: UnregisteredAccount) => account.Name,
      header: "Name",
      id: "Name",
    },
  ];

  return (
    <>
      <Table
        header="Add Accounts"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              iconName="refresh"
              onClick={() => refetch()}
              disabled={getUnregisteredAccountsIsLoading}
            />
            <Button
              iconName="add-plus"
              onClick={() => setShowCreateAccountModal(true)}
            >
              Create GovCloud Account
            </Button>
            <Button
              variant="primary"
              onClick={showRegisterModal}
              disabled={selectedAccounts.length === 0}
            >
              Register Existing
            </Button>
          </SpaceBetween>
        }
        trackBy="Id"
        columnDefinitions={columnDefinitions}
        items={unregisteredAccounts ?? []}
        loading={getUnregisteredAccountsIsFetching}
        selectionType="multi"
        selectedItems={selectedAccounts}
        onSelectionChange={({ detail }) =>
          setSelectedAccounts(detail.selectedItems)
        }
        stripedRows
        enableKeyboardNavigation
      />
      <Modal
      visible={showCreateAccountModal}
      onDismiss={() => {
        if (!executionId) resetForm(); // Only allow dismiss if no workflow running
      }}
      header="GovCloud Account Workflow"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="link"
              onClick={resetForm}
              disabled={!!executionId} // Disable cancel while workflow running
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateGovCloudAccount}
              disabled={
                (mode === "create" && (!accountName || !email)) ||
                (mode === "join-existing" && !selectedGovCloudAccount) ||
                isCreatingAccount ||
                !!executionId // Disable while workflow is running
              }
              loading={isCreatingAccount || (!!executionId && statusData?.status === "RUNNING")}
            >
              {mode === "create" ? "Create Account" : "Join Selected Account"}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <FormField label="Mode" description="Choose workflow mode">
          <RadioGroup
            value={mode}
            onChange={({ detail }) => setMode(detail.value as "create" | "join-existing")}
            items={[
              {
                value: "create",
                label: "Create New Account",
                description: "Create a new GovCloud account and join it to your organization",
              },
              {
                value: "join-existing",
                label: "Join Existing Account",
                description: "Join an existing GovCloud account to your organization",
              },
            ]}
          />
        </FormField>

        {mode === "create" ? (
          <>
            <Alert type="info">
              This will create a new GovCloud account, automatically join it to
              your organization, and register it in the Innovation Sandbox. This
              process takes approximately 5-10 minutes.
            </Alert>

            <FormField label="Account Name" description="Name for the new account">
              <Input
                value={accountName}
                onChange={({ detail }) => setAccountName(detail.value)}
                placeholder="My-GovCloud-Account"
              />
            </FormField>

            <FormField
              label="Email"
              description="Your email (will be aliased automatically for uniqueness)"
            >
              <Input
                value={email}
                onChange={({ detail }) => setEmail(detail.value)}
                placeholder="your-email@example.com"
                type="email"
              />
            </FormField>
          </>
        ) : (
          <>
            <Alert type="info">
              Select an existing GovCloud account to join to your organization
              and register in the Innovation Sandbox. This process takes
              approximately 3-5 minutes.
            </Alert>

            <Table
              header="Available GovCloud Accounts"
              columnDefinitions={[
                {
                  id: "accountName",
                  header: "Account Name",
                  cell: (item: any) => item.accountName,
                },
                {
                  id: "govCloudAccountId",
                  header: "GovCloud Account ID",
                  cell: (item: any) => item.govCloudAccountId,
                },
                {
                  id: "commercialAccountId",
                  header: "Commercial Account ID",
                  cell: (item: any) => item.commercialAccountId,
                },
                {
                  id: "createTime",
                  header: "Created",
                  cell: (item: any) => new Date(item.createTime).toLocaleString(),
                },
              ]}
              items={availableGovCloudAccounts ?? []}
              loading={isLoadingAvailable}
              selectionType="single"
              selectedItems={selectedGovCloudAccount ? [selectedGovCloudAccount] : []}
              onSelectionChange={({ detail }) =>
                setSelectedGovCloudAccount(detail.selectedItems[0] || null)
              }
              trackBy="govCloudAccountId"
              empty={
                <Box textAlign="center" color="inherit">
                  <b>No available accounts</b>
                  <Box variant="p" color="inherit">
                    All GovCloud accounts have been joined to the organization.
                  </Box>
                </Box>
              }
            />
          </>
        )}

        {(isCreatingAccount || executionId) && (
          <Alert type="info" header="Workflow In Progress">
            <SpaceBetween size="s">
              <Spinner />
              {!statusData || !statusData.status ? (
                <div>Initiating workflow...</div>
              ) : statusData.status === "RUNNING" ? (
                <div>Workflow in progress. This may take {mode === "create" ? "5-10" : "3-5"} minutes...</div>
              ) : (
                <div>Status: {statusData.status}</div>
              )}
              {executionId && <div style={{ fontSize: '0.875em', opacity: 0.7 }}>Execution ID: {executionId}</div>}
            </SpaceBetween>
          </Alert>
        )}
      </SpaceBetween>
    </Modal>
    </>
  );
};
