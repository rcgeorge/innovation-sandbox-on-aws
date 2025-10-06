// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostAndUsageCommandInput,
} from "@aws-sdk/client-cost-explorer";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const costExplorer = new CostExplorerClient({});

interface CostQueryParams {
  linkedAccountId: string;
  startDate: string;
  endDate: string;
  granularity?: "DAILY" | "MONTHLY";
  region?: string; // Optional: filter by specific region (e.g., us-gov-east-1)
}

interface CostBreakdown {
  service: string;
  cost: number;
}

interface CostResponse {
  linkedAccountId: string;
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

function parseQueryParams(event: APIGatewayProxyEvent): CostQueryParams | { error: string } {
  const linkedAccountId = event.queryStringParameters?.linkedAccountId;
  const startDate = event.queryStringParameters?.startDate;
  const endDate = event.queryStringParameters?.endDate;
  const granularity = (event.queryStringParameters?.granularity || "DAILY") as "DAILY" | "MONTHLY";
  const region = event.queryStringParameters?.region; // Optional region filter

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

  return { linkedAccountId, startDate, endDate, granularity, region };
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log("Event:", JSON.stringify(event, null, 2));

  try {
    // Parse and validate query parameters
    const params = parseQueryParams(event);
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

    const { linkedAccountId, startDate, endDate, granularity, region } = params;

    // Build Cost Explorer query with optional region filter
    const filters: any[] = [
      {
        Dimensions: {
          Key: "LINKED_ACCOUNT",
          Values: [linkedAccountId],
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
      linkedAccountId,
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
