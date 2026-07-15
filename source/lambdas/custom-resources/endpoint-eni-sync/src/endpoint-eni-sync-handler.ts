// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * This Lambda resolves VPC interface-endpoint network interface IPs and
 * registers/deregisters them in ALB IP target groups. VPC endpoint ENI IPs can
 * change on endpoint creation, scaling, or during AZ recovery — this handler
 * ensures target groups stay in sync.
 *
 * Invoked on a schedule (e.g. every 5 min) and optionally on endpoint-change
 * EventBridge events.
 *
 * Environment variable format for ENDPOINT_TARGET_GROUP_MAPPINGS:
 *   vpce-abc123:arn:...:targetgroup/tg1/xxx,vpce-def456:arn:...:targetgroup/tg2/yyy
 */

import {
  DescribeNetworkInterfacesCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  DeregisterTargetsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  RegisterTargetsCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "endpoint-eni-sync" });
const ec2 = new EC2Client({});
const elbv2 = new ElasticLoadBalancingV2Client({});

interface EndpointMapping {
  endpointId: string;
  targetGroupArn: string;
}

function parseMappings(raw: string): EndpointMapping[] {
  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const sepIndex = pair.indexOf(":");
      if (sepIndex === -1) {
        throw new Error(`Invalid mapping format: "${pair}". Expected vpce-xxx:arn:...`);
      }
      // The endpoint ID is the part before the first colon that starts with vpce-
      // But target-group ARNs also contain colons, so split on the first ':arn:'
      const arnSep = pair.indexOf(":arn:");
      if (arnSep === -1) {
        throw new Error(
          `Invalid mapping format: "${pair}". Expected vpce-xxx:arn:...`,
        );
      }
      return {
        endpointId: pair.slice(0, arnSep),
        targetGroupArn: pair.slice(arnSep + 1),
      };
    });
}

async function getEndpointIps(endpointId: string): Promise<string[]> {
  const response = await ec2.send(
    new DescribeNetworkInterfacesCommand({
      Filters: [
        {
          Name: "vpc-id",
          Values: ["*"], // scope is implicit via endpoint
        },
        {
          Name: "interface-type",
          Values: ["vpc_endpoint"],
        },
        {
          Name: "description",
          Values: [`*${endpointId}*`],
        },
      ],
    }),
  );

  const ips: string[] = [];
  for (const eni of response.NetworkInterfaces ?? []) {
    if (eni.PrivateIpAddress) {
      ips.push(eni.PrivateIpAddress);
    }
  }
  return ips;
}

async function getCurrentTargets(targetGroupArn: string): Promise<string[]> {
  const response = await elbv2.send(
    new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn }),
  );
  return (response.TargetHealthDescriptions ?? [])
    .map((thd) => thd.Target?.Id)
    .filter((id): id is string => !!id);
}

async function syncTargetGroup(mapping: EndpointMapping): Promise<void> {
  const desiredIps = await getEndpointIps(mapping.endpointId);
  const currentIps = await getCurrentTargets(mapping.targetGroupArn);

  const toRegister = desiredIps.filter((ip) => !currentIps.includes(ip));
  const toDeregister = currentIps.filter((ip) => !desiredIps.includes(ip));

  if (toDeregister.length > 0) {
    logger.info("Deregistering stale IPs", {
      targetGroupArn: mapping.targetGroupArn,
      ips: toDeregister,
    });
    await elbv2.send(
      new DeregisterTargetsCommand({
        TargetGroupArn: mapping.targetGroupArn,
        Targets: toDeregister.map((ip) => ({ Id: ip })),
      }),
    );
  }

  if (toRegister.length > 0) {
    logger.info("Registering new IPs", {
      targetGroupArn: mapping.targetGroupArn,
      ips: toRegister,
    });
    await elbv2.send(
      new RegisterTargetsCommand({
        TargetGroupArn: mapping.targetGroupArn,
        Targets: toRegister.map((ip) => ({ Id: ip })),
      }),
    );
  }

  if (toRegister.length === 0 && toDeregister.length === 0) {
    logger.info("Target group already in sync", {
      targetGroupArn: mapping.targetGroupArn,
      ips: desiredIps,
    });
  }
}

export async function handler(): Promise<void> {
  const raw = process.env.ENDPOINT_TARGET_GROUP_MAPPINGS;
  if (!raw) {
    throw new Error("ENDPOINT_TARGET_GROUP_MAPPINGS is not set");
  }

  const mappings = parseMappings(raw);
  logger.info("Syncing endpoint ENI IPs to target groups", {
    mappingCount: mappings.length,
  });

  const results = await Promise.allSettled(
    mappings.map((m) => syncTargetGroup(m)),
  );

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    for (const f of failures) {
      logger.error("Sync failed", { reason: (f as PromiseRejectedResult).reason });
    }
    throw new Error(`${failures.length}/${mappings.length} sync(s) failed`);
  }
}
