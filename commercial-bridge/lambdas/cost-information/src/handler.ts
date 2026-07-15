// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Commercial-partition cost API. Deployed to the commercial (aws partition)
 * account that is billed for paired GovCloud accounts' usage. GovCloud Lambdas
 * call this endpoint (SigV4-signed via IAM Roles Anywhere) because Cost
 * Explorer is not available in the GovCloud partition.
 *
 * POST /cost-info
 *   { linkedAccountId, startDate, endDate, granularity?, region?,
 *     isGovCloudAccountId?, commercialAccountId? }
 *
 * When isGovCloudAccountId is set, the GovCloud account id is mapped to its
 * paired commercial account — either via the explicit commercialAccountId, or
 * auto-discovered from Organizations ListCreateAccountStatus (GovCloudAccountId
 * → AccountId). The commercial account id is what Cost Explorer is queried on.
 */
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostAndUsageCommandInput,
} from "@aws-sdk/client-cost-explorer";
import {
  CreateAccountState,
  ListCreateAccountStatusCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";

const costExplorer = new CostExplorerClient({});
const organizations = new OrganizationsClient({});

// GovCloud → commercial account mapping cache, persisted across warm invokes.
let mappingCache: Map<string, string> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CostQueryParams {
  linkedAccountId: string;
  startDate: string;
  endDate: string;
  granularity: "DAILY" | "MONTHLY";
  region?: string;
  isGovCloudAccountId?: boolean;
  commercialAccountId?: string;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function response(
  statusCode: number,
  body: unknown,
): APIGatewayProxyResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return !isNaN(date.getTime());
}

function parseRequest(
  event: APIGatewayProxyEvent,
): CostQueryParams | { error: string } {
  if (!event.body) return { error: "Request body is required" };

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { error: "Invalid JSON in request body" };
  }

  const linkedAccountId = body.linkedAccountId as string;
  const startDate = body.startDate as string;
  const endDate = body.endDate as string;
  const granularity = ((body.granularity as string) || "DAILY") as
    | "DAILY"
    | "MONTHLY";

  if (!linkedAccountId) return { error: "linkedAccountId is required" };
  if (!startDate || !isValidDate(startDate)) {
    return { error: "startDate is required and must be YYYY-MM-DD" };
  }
  if (!endDate || !isValidDate(endDate)) {
    return { error: "endDate is required and must be YYYY-MM-DD" };
  }
  if (new Date(startDate) > new Date(endDate)) {
    return { error: "startDate must be before endDate" };
  }

  return {
    linkedAccountId,
    startDate,
    endDate,
    granularity,
    region: body.region as string | undefined,
    isGovCloudAccountId: body.isGovCloudAccountId === true,
    commercialAccountId: body.commercialAccountId as string | undefined,
  };
}

async function buildMappingCache(): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  let nextToken: string | undefined;
  do {
    const res = await organizations.send(
      new ListCreateAccountStatusCommand({
        States: [CreateAccountState.SUCCEEDED],
        MaxResults: 20,
        NextToken: nextToken,
      }),
    );
    for (const status of res.CreateAccountStatuses ?? []) {
      if (status.GovCloudAccountId && status.AccountId) {
        cache.set(status.GovCloudAccountId, status.AccountId);
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return cache;
}

async function resolveCommercialAccount(
  govCloudAccountId: string,
): Promise<string | null> {
  if (mappingCache && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    const hit = mappingCache.get(govCloudAccountId);
    if (hit) return hit;
  }
  mappingCache = await buildMappingCache();
  cacheTimestamp = Date.now();
  return mappingCache.get(govCloudAccountId) ?? null;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const params = parseRequest(event);
    if ("error" in params) {
      return response(400, { error: params.error });
    }

    let commercialAccountId = params.linkedAccountId;
    let govCloudAccountId: string | undefined;

    if (params.isGovCloudAccountId) {
      govCloudAccountId = params.linkedAccountId;
      if (params.commercialAccountId) {
        commercialAccountId = params.commercialAccountId;
      } else {
        const resolved = await resolveCommercialAccount(params.linkedAccountId);
        if (!resolved) {
          return response(404, {
            error: "No commercial account mapping found",
            message:
              `Could not find a commercial account linked to GovCloud account ` +
              `${params.linkedAccountId}. Provide 'commercialAccountId' in the request body.`,
            govCloudAccountId: params.linkedAccountId,
          });
        }
        commercialAccountId = resolved;
      }
    }

    const filters: GetCostAndUsageCommandInput["Filter"][] = [
      { Dimensions: { Key: "LINKED_ACCOUNT", Values: [commercialAccountId] } },
    ];
    if (params.region) {
      filters.push({ Dimensions: { Key: "REGION", Values: [params.region] } });
    }

    const input: GetCostAndUsageCommandInput = {
      TimePeriod: { Start: params.startDate, End: params.endDate },
      Granularity: params.granularity,
      Metrics: ["UnblendedCost"],
      Filter: filters.length === 1 ? filters[0] : { And: filters as object[] },
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    };

    const result = await costExplorer.send(new GetCostAndUsageCommand(input));

    let totalCost = 0;
    const serviceMap = new Map<string, number>();
    for (const period of result.ResultsByTime ?? []) {
      for (const group of period.Groups ?? []) {
        const service = group.Keys?.[0] ?? "Unknown";
        const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount ?? "0");
        serviceMap.set(service, (serviceMap.get(service) ?? 0) + cost);
        totalCost += cost;
      }
    }

    const breakdown = Array.from(serviceMap.entries())
      .map(([service, cost]) => ({ service, cost: round2(cost) }))
      .sort((a, b) => b.cost - a.cost);

    return response(200, {
      linkedAccountId: commercialAccountId,
      govCloudAccountId,
      commercialAccountId: params.isGovCloudAccountId
        ? commercialAccountId
        : undefined,
      startDate: params.startDate,
      endDate: params.endDate,
      totalCost: round2(totalCost),
      currency: "USD",
      breakdown,
    });
  } catch (error) {
    return response(500, {
      error: "Failed to retrieve cost information",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
