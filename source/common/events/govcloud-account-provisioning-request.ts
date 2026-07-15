// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";

export const GovCloudAccountProvisioningRequestSchema = z.object({
  accountName: z.string().min(1).max(50),
  email: z.string().email(),
  requestedBy: z.string(),
});

export type GovCloudAccountProvisioningRequestData = z.infer<
  typeof GovCloudAccountProvisioningRequestSchema
>;

/**
 * Emitted by POST /accounts/govcloud to kick off cross-partition GovCloud
 * account provisioning. Consumed by the GovCloud provisioning Step Function
 * (only deployed when enableGovCloudAccountProvisioning is set).
 */
export class GovCloudAccountProvisioningRequest implements IsbEvent {
  readonly DetailType = EventDetailTypes.GovCloudAccountProvisioningRequest;
  readonly Detail: GovCloudAccountProvisioningRequestData;

  constructor(eventData: GovCloudAccountProvisioningRequestData) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new GovCloudAccountProvisioningRequest(
      GovCloudAccountProvisioningRequestSchema.parse(eventDetail),
    );
  }
}
