// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCreateGovCloudAccount } from "@amzn/innovation-sandbox-frontend/domains/accounts/hooks";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  Alert,
  Box,
  Button,
  Form,
  FormField,
  Input,
  Modal,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useState } from "react";

export interface CreateGovCloudAccountModalProps {
  visible: boolean;
  onClose: () => void;
}

export const CreateGovCloudAccountModal = ({
  visible,
  onClose,
}: CreateGovCloudAccountModalProps) => {
  const [accountName, setAccountName] = useState("");
  const [email, setEmail] = useState("");
  const { mutateAsync: createGovCloudAccount, isPending } =
    useCreateGovCloudAccount();

  const reset = () => {
    setAccountName("");
    setEmail("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const trimmedName = accountName.trim();
  const nameValid = trimmedName.length > 0 && trimmedName.length <= 50;
  const canSubmit = nameValid && emailValid && !isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    try {
      await createGovCloudAccount({ accountName: trimmedName, email });
      showSuccessToast(
        "GovCloud account provisioning started. The account will appear under unregistered accounts once created and joined.",
      );
      handleClose();
    } catch (error) {
      showErrorToast(
        error instanceof Error
          ? error.message
          : "Failed to start GovCloud account provisioning.",
        "Provisioning error",
      );
    }
  };

  return (
    <Modal
      visible={visible}
      onDismiss={handleClose}
      header="Create GovCloud Account"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={handleClose} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              loading={isPending}
              disabled={!canSubmit}
            >
              Create
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <Form>
        <SpaceBetween size="m">
          <Alert type="info">
            This creates a new GovCloud account (and its paired commercial
            account) via the commercial bridge, joins it to the organization,
            and moves it into the Entry OU. Provisioning runs asynchronously and
            can take several minutes.
          </Alert>
          <FormField
            label="Account name"
            description="A name for the new GovCloud account (max 50 characters)."
            errorText={
              trimmedName.length > 50
                ? "Account name must be at most 50 characters"
                : undefined
            }
          >
            <Input
              value={accountName}
              onChange={({ detail }) => setAccountName(detail.value)}
              placeholder="my-sandbox-account"
              disabled={isPending}
            />
          </FormField>
          <FormField
            label="Email"
            description="Root email for the new account. A unique +alias is applied automatically."
            errorText={
              email.length > 0 && !emailValid ? "Enter a valid email" : undefined
            }
          >
            <Input
              value={email}
              onChange={({ detail }) => setEmail(detail.value)}
              placeholder="team@example.com"
              disabled={isPending}
            />
          </FormField>
        </SpaceBetween>
      </Form>
    </Modal>
  );
};
