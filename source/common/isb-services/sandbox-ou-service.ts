// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  AcceptHandshakeCommand,
  Account,
  ConcurrentModificationException,
  DescribeAccountCommand,
  InviteAccountToOrganizationCommand,
  ListAccountsForParentCommand,
  ListRootsCommand,
  MoveAccountCommand,
  OrganizationalUnit,
  OrganizationsClient,
  paginateListAccountsForParent,
  paginateListOrganizationalUnitsForParent,
  TooManyRequestsException,
} from "@aws-sdk/client-organizations";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import {
  IsbOu,
  SandboxAccount,
  SandboxAccountStatus,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";
import { backOff } from "exponential-backoff";

export class SandboxOuService {
  readonly orgsClient: OrganizationsClient;
  readonly namespace: string;
  readonly sandboxAccountStore: SandboxAccountStore;
  readonly sandboxOuId: string;

  constructor(props: {
    namespace: string;
    sandboxAccountStore: SandboxAccountStore;
    sandboxOuId: string;
    orgsClient: OrganizationsClient;
  }) {
    this.orgsClient = props.orgsClient;
    this.sandboxAccountStore = props.sandboxAccountStore;
    this.namespace = props.namespace;
    this.sandboxOuId = props.sandboxOuId;
  }

  private async listChildrenOus(
    parentId: string,
  ): Promise<OrganizationalUnit[]> {
    const listChildrenPaginator = paginateListOrganizationalUnitsForParent(
      {
        client: this.orgsClient,
      },
      {
        ParentId: parentId,
      },
    );
    const children: OrganizationalUnit[] = [];
    for await (const page of listChildrenPaginator) {
      if (page.OrganizationalUnits) {
        children.push(...page.OrganizationalUnits);
      }
    }
    return children;
  }

  async getIsbOu(ouName: IsbOu): Promise<OrganizationalUnit> {
    const sandboxOus = await this.listChildrenOus(this.sandboxOuId);
    for (const ou of sandboxOus) {
      if (ou.Name === ouName) {
        return ou;
      }
    }
    throw new Error(`Requested OU not found in Innovation Sandbox.`);
  }

  public async performAccountMoveAction(
    accountId: string,
    sourceOu: IsbOu,
    destinationOu: IsbOu,
  ) {
    const sourceOuId = (await this.getIsbOu(sourceOu))!.Id;
    const destinationOuId = (await this.getIsbOu(destinationOu))!.Id;

    await backOff(
      () =>
        this.orgsClient.send(
          new MoveAccountCommand({
            AccountId: accountId,
            SourceParentId: sourceOuId,
            DestinationParentId: destinationOuId,
          }),
        ),
      {
        numOfAttempts: 5,
        jitter: "full",
        startingDelay: 1000,
        retry(error) {
          if (
            error instanceof ConcurrentModificationException ||
            error instanceof TooManyRequestsException
          ) {
            return true;
          }
          return false;
        },
      },
    );
  }

  public async moveAccount(
    account: SandboxAccount,
    sourceOu: IsbOu,
    destinationOu: IsbOu,
  ) {
    await this.performAccountMoveAction(
      account.awsAccountId,
      sourceOu,
      destinationOu,
    );
    return this.sandboxAccountStore.put({
      ...account,
      status: destinationOu as SandboxAccountStatus,
    });
  }

  public transactionalMoveAccount(
    account: SandboxAccount,
    sourceOu: IsbOu,
    destinationOu: IsbOu,
  ) {
    return new Transaction({
      beginTransaction: () =>
        this.moveAccount(account, sourceOu, destinationOu),
      rollbackTransaction: async () => {
        await this.moveAccount(account, destinationOu, sourceOu); // NOSONAR typescript:S2234 - function parameters not matching the parameter names is intentional
      },
    });
  }

  public async listAllAccountsInOU(ouName: IsbOu) {
    const listAccountsPaginator = paginateListAccountsForParent(
      {
        client: this.orgsClient,
      },
      {
        ParentId: (await this.getIsbOu(ouName)).Id,
      },
    );

    const accounts: Account[] = [];
    for await (const page of listAccountsPaginator) {
      if (page.Accounts) {
        accounts.push(...page.Accounts);
      }
    }
    return accounts;
  }

  public async listAccountsInOU(options: {
    ouName: IsbOu;
    pageSize?: number;
    pageIdentifier?: string;
  }) {
    const { ouName, pageIdentifier, pageSize } = options;
    const { Accounts, NextToken } = await this.orgsClient.send(
      new ListAccountsForParentCommand({
        ParentId: (await this.getIsbOu(ouName)).Id,
        NextToken: pageIdentifier,
        MaxResults: pageSize,
      }),
    );

    return {
      accounts: Accounts,
      nextPageIdentifier: NextToken,
    };
  }

  public async describeAccount(options: { accountId: string }) {
    const { accountId } = options;
    const { Account } = await this.orgsClient.send(
      new DescribeAccountCommand({ AccountId: accountId }),
    );

    return (
      Account && {
        accountId: Account.Id,
        name: Account.Name,
        email: Account.Email,
      }
    );
  }

  public async inviteAccountToOrganization(accountId: string): Promise<{ handshakeId: string }> {
    try {
      const response = await this.orgsClient.send(
        new InviteAccountToOrganizationCommand({
          Target: {
            Id: accountId,
            Type: "ACCOUNT"
          }
        })
      );

      if (!response.Handshake?.Id) {
        throw new Error("Failed to get handshake ID from invitation response");
      }

      return { handshakeId: response.Handshake.Id };
    } catch (error: any) {
      // If account is already in the organization, return a placeholder handshake ID
      if (error.name === "HandshakeConstraintViolationException" &&
          error.message?.includes("already a member")) {
        return { handshakeId: "already-joined" };
      }

      // If invitation already exists, find it and return the existing handshake ID
      if (error.name === "DuplicateHandshakeException") {
        const { ListHandshakesForOrganizationCommand } = await import("@aws-sdk/client-organizations");
        const listResponse = await this.orgsClient.send(
          new ListHandshakesForOrganizationCommand({
            Filter: {
              ActionType: "INVITE"
            }
          })
        );

        const existingHandshake = listResponse.Handshakes?.find(
          h => h.Parties?.some(p => p.Id === accountId) && h.State === "OPEN"
        );

        if (existingHandshake?.Id) {
          return { handshakeId: existingHandshake.Id };
        }

        throw new Error(`Duplicate invitation exists but couldn't find open handshake for account ${accountId}`);
      }

      throw error;
    }
  }

  public async acceptHandshakeAsAccount(
    accountId: string,
    handshakeId: string
  ): Promise<void> {
    // Assume OrganizationAccountAccessRole in the account being invited
    const stsClient = new STSClient({ region: this.orgsClient.config.region as string });

    const assumeRoleResponse = await stsClient.send(
      new AssumeRoleCommand({
        RoleArn: `arn:aws-us-gov:iam::${accountId}:role/OrganizationAccountAccessRole`,
        RoleSessionName: "AcceptOrgInvitation"
      })
    );

    // Create Organizations client with the assumed role credentials
    const accountOrgsClient = new OrganizationsClient({
      region: this.orgsClient.config.region,
      credentials: {
        accessKeyId: assumeRoleResponse.Credentials!.AccessKeyId!,
        secretAccessKey: assumeRoleResponse.Credentials!.SecretAccessKey!,
        sessionToken: assumeRoleResponse.Credentials!.SessionToken!
      }
    });

    // Accept the handshake
    await accountOrgsClient.send(
      new AcceptHandshakeCommand({
        HandshakeId: handshakeId
      })
    );
  }

  public async moveAccountToEntryOu(accountId: string): Promise<void> {
    // Get Entry OU ID
    const entryOu = await this.getOuByName("Entry");

    // Check if account is already in Entry OU
    const { ListParentsCommand } = await import("@aws-sdk/client-organizations");
    const parentsResponse = await this.orgsClient.send(
      new ListParentsCommand({ ChildId: accountId })
    );

    const currentParentId = parentsResponse.Parents?.[0]?.Id;

    if (currentParentId === entryOu.Id) {
      // Account already in Entry OU, nothing to do
      return;
    }

    // Get root ID for source (account is either at root or in another OU)
    const rootResponse = await this.orgsClient.send(new ListRootsCommand({}));
    const rootId = rootResponse.Roots?.[0]?.Id;

    if (!rootId) {
      throw new Error("Failed to get organization root ID");
    }

    // Use current parent as source (could be root or another OU)
    const sourceParentId = currentParentId || rootId;

    // Move account to Entry OU
    await this.orgsClient.send(
      new MoveAccountCommand({
        AccountId: accountId,
        SourceParentId: sourceParentId,
        DestinationParentId: entryOu.Id
      })
    );
  }

  private async getOuByName(ouName: IsbOu): Promise<OrganizationalUnit> {
    const childOus = await this.listChildrenOus(this.sandboxOuId);
    const ou = childOus.find(ou => ou.Name === ouName);

    if (!ou) {
      throw new Error(`OU ${ouName} not found under sandbox OU ${this.sandboxOuId}`);
    }

    return ou;
  }
}
