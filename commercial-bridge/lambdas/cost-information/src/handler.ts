// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostAndUsageCommandInput,
} from "@aws-sdk/client-cost-explorer";
import {
  OrganizationsClient,
  ListCreateAccountStatusCommand,
  CreateAccountState,
  CreateAccountStatus,
} from "@aws-sdk/client-organizations";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const costExplorer = new CostExplorerClient({});
const organizations = new OrganizationsClient({});

// Cache for GovCloud -> Commercial account mapping
// Persists across warm Lambda invocations
let mappingCache: Map<string, string> | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CostQueryParams {
  linkedAccountId: string;
  startDate: string;
  endDate: string;
  granularity?: "DAILY" | "MONTHLY";
  region?: string; // Optional: filter by specific region (e.g., us-gov-east-1)
  isGovCloudAccountId?: boolean; // NEW: Indicates linkedAccountId is a GovCloud account ID
  commercialAccountId?: string; // NEW: Explicit commercial account ID (bypasses auto-discovery)
}

interface CostBreakdown {
  service: string;
  cost: number;
}

interface CostResponse {
  linkedAccountId: string;
  govCloudAccountId?: string; // NEW: Included if request was for GovCloud account
  commercialAccountId?: string; // NEW: Included if request was for GovCloud account
  startDate: string;
  endDate: string;
  totalCost: number;
  currency: string;
  breakdown: CostBreakdown[];
}

function validateDate(dateString: string): boolean {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date.getTime());
}

function parseRequestBody(event: APIGatewayProxyEvent): CostQueryParams | { error: string } {
  if (!event.body) {
    return { error: "Request body is required" };
  }

  try {
    const body = JSON.parse(event.body);

    const linkedAccountId = body.linkedAccountId;
    const startDate = body.startDate;
    const endDate = body.endDate;
    const granularity = (body.granularity || "DAILY") as "DAILY" | "MONTHLY";
    const region = body.region; // Optional region filter
    const isGovCloudAccountId = body.isGovCloudAccountId === true;
    const commercialAccountId = body.commercialAccountId; // Optional explicit commercial account ID

    if (!linkedAccountId) {
      return { error: "linkedAccountId is required" };
    }

    if (!startDate || !validateDate(startDate)) {
      return { error: "startDate is required and must be in YYYY-MM-DD format" };
    }

    if (!endDate || !validateDate(endDate)) {
      return { error: "endDate is required and must be in YYYY-MM-DD format" };
    }

    if (new Date(startDate) > new Date(endDate)) {
      return { error: "startDate must be before endDate" };
    }

    return { linkedAccountId, startDate, endDate, granularity, region, isGovCloudAccountId, commercialAccountId };
  } catch (error) {
    return { error: "Invalid JSON in request body" };
  }
}

async function buildAccountMappingCache(): Promise<Map<string, string>> {
  console.log("Building GovCloud -> Commercial account mapping cache...");
  const cache = new Map<string, string>();
  let nextToken: string | undefined;

  do {
    const command = new ListCreateAccountStatusCommand({
      States: [CreateAccountState.SUCCEEDED],
      MaxResults: 20,
      NextToken: nextToken,
    });
    const response = await organizations.send(command);

    const statuses = response.CreateAccountStatuses || [];
    for (const status of statuses) {
      // Only cache GovCloud account creations (those with GovCloudAccountId)
      if (status.GovCloudAccountId && status.AccountId) {
        cache.set(status.GovCloudAccountId, status.AccountId);
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  console.log(`Built mapping cache with ${cache.size} GovCloud accounts`);
  return cache;
}

async function findCommercialAccountForGovCloud(govCloudAccountId: string): Promise<{
  commercialAccountId: string;
  govCloudAccountId: string;
} | null> {
  // Check cache first
  if (mappingCache && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    const commercialId = mappingCache.get(govCloudAccountId);
    if (commercialId) {
      console.log(`Cache hit: GovCloud ${govCloudAccountId} -> Commercial ${commercialId}`);
      return { commercialAccountId: commercialId, govCloudAccountId };
    }
  }

  // Cache miss or expired - rebuild cache
  console.log("Cache miss or expired, rebuilding...");
  mappingCache = await buildAccountMappingCache();
  cacheTimestamp = Date.now();

  const commercialId = mappingCache.get(govCloudAccountId);
  if (commercialId) {
    console.log(`Found mapping: GovCloud ${govCloudAccountId} -> Commercial ${commercialId}`);
    return { commercialAccountId: commercialId, govCloudAccountId };
  }

  console.log(`No mapping found for GovCloud account ${govCloudAccountId}`);
  return null;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log("Event:", JSON.stringify(event, null, 2));

  try {
    // Parse and validate request body
    const params = parseRequestBody(event);
    if ("error" in params) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: params.error }),
      };
    }

    const { linkedAccountId, startDate, endDate, granularity, region, isGovCloudAccountId, commercialAccountId: explicitCommercialId } = params;

    // NEW: Handle GovCloud account mapping
    let commercialAccountId = linkedAccountId;
    let govCloudAccountId: string | undefined = undefined;

    if (isGovCloudAccountId) {
      govCloudAccountId = linkedAccountId;

      // If explicit commercial account ID provided, use it (manual mapping)
      if (explicitCommercialId) {
        console.log(`Using explicit commercial account ${explicitCommercialId} for GovCloud account ${linkedAccountId}`);
        commercialAccountId = explicitCommercialId;
      } else {
        // Otherwise, try to auto-discover via ListCreateAccountStatus
        console.log(`Auto-discovering commercial account for GovCloud account ${linkedAccountId}`);
        const mapping = await findCommercialAccountForGovCloud(linkedAccountId);

        if (!mapping) {
          return {
            statusCode: 404,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
            body: JSON.stringify({
              error: "No commercial account mapping found",
              message: `Could not find a commercial account linked to GovCloud account ${linkedAccountId}. This account may have been created outside of the CreateGovCloudAccount API. Please provide 'commercialAccountId' in the request body.`,
              govCloudAccountId: linkedAccountId,
            }),
          };
        }

        commercialAccountId = mapping.commercialAccountId;
        console.log(`Auto-discovered commercial account ${commercialAccountId}`);
      }
    }

    // Build Cost Explorer query with optional region filter
    const filters: any[] = [
      {
        Dimensions: {
          Key: "LINKED_ACCOUNT",
          Values: [commercialAccountId], // Use commercial account ID for Cost Explorer
        },
      },
    ];

    // Add region filter if specified
    if (region) {
      filters.push({
        Dimensions: {
          Key: "REGION",
          Values: [region],
        },
      });
    }

    const input: GetCostAndUsageCommandInput = {
      TimePeriod: {
        Start: startDate,
        End: endDate,
      },
      Granularity: granularity,
      Metrics: ["UnblendedCost"],
      Filter: filters.length === 1 ? filters[0] : {
        And: filters,
      },
      GroupBy: [
        {
          Type: "DIMENSION",
          Key: "SERVICE",
        },
      ],
    };

    console.log("Querying Cost Explorer:", JSON.stringify(input, null, 2));

    // Query Cost Explorer
    const command = new GetCostAndUsageCommand(input);
    const response = await costExplorer.send(command);

    console.log("Cost Explorer response:", JSON.stringify(response, null, 2));

    // Parse and aggregate results
    let totalCost = 0;
    const serviceMap = new Map<string, number>();

    if (response.ResultsByTime) {
      for (const result of response.ResultsByTime) {
        if (result.Groups) {
          for (const group of result.Groups) {
            const service = group.Keys?.[0] || "Unknown";
            const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");

            serviceMap.set(service, (serviceMap.get(service) || 0) + cost);
            totalCost += cost;
          }
        }
      }
    }

    // Build response
    const breakdown: CostBreakdown[] = Array.from(serviceMap.entries())
      .map(([service, cost]) => ({
        service,
        cost: Math.round(cost * 100) / 100, // Round to 2 decimal places
      }))
      .sort((a, b) => b.cost - a.cost); // Sort by cost descending

    const responseBody: CostResponse = {
      linkedAccountId: commercialAccountId, // The account ID used for Cost Explorer query
      govCloudAccountId: govCloudAccountId, // Include if this was a GovCloud lookup
      commercialAccountId: isGovCloudAccountId ? commercialAccountId : undefined, // Include if this was a GovCloud lookup
      startDate,
      endDate,
      totalCost: Math.round(totalCost * 100) / 100,
      currency: "USD",
      breakdown,
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(responseBody),
    };
  } catch (error) {
    console.error("Error querying cost information:", error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Failed to retrieve cost information",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
};
