// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { isGovCloud } from "@amzn/innovation-sandbox-infrastructure/helpers/govcloud-mode";
import { Duration } from "aws-cdk-lib";
import { EventBus, Rule, RuleProps } from "aws-cdk-lib/aws-events";
import { SqsQueue, SqsQueueProps } from "aws-cdk-lib/aws-events-targets";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnEventSourceMapping, IFunction } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { IQueue, Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

interface EventsToSqsToLambdaProps {
  namespace: string;
  lambdaFunction: IFunction;
  eventBus: EventBus;
  sqsQueueProps: SqsQueueProps;
  ruleProps: RuleProps;
  queueProps?: Partial<IQueue>;
}

export class EventsToSqsToLambda extends Construct {
  public readonly queue: IQueue;

  constructor(scope: Construct, id: string, props: EventsToSqsToLambdaProps) {
    super(scope, id);
    const kmsKey = IsbKmsKeys.get(scope, props.namespace);
    this.queue = new Queue(this, "AccountLifeCycleEventsQueue", {
      queueName: `Isb-${props.namespace}-AccountLifeCycleEventsQueue.fifo`,
      encryptionMasterKey: kmsKey,
      retentionPeriod: Duration.hours(4),
      visibilityTimeout: Duration.minutes(2), // the lambda timout is 1 min
      fifo: true,
      contentBasedDeduplication: true,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: new Queue(this, "AccountLifeCycleEventsDLQ", {
          queueName: `Isb-${props.namespace}-AccountLifeCycleEventsDLQ.fifo`,
          fifo: true,
          contentBasedDeduplication: true,
          encryption: QueueEncryption.KMS,
          encryptionMasterKey: kmsKey,
        }),
      },
      ...props.queueProps,
    });

    const rule = new Rule(this, "AccountLifeCycleEventsRule", props.ruleProps);
    rule.addTarget(
      new SqsQueue(this.queue, {
        messageGroupId: "AccountLifeCycleEvents",
        ...props.sqsQueueProps,
      }),
    );
    this.queue.grantSendMessages(new ServicePrincipal("events.amazonaws.com"));

    props.lambdaFunction.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: 1,
      }),
    );

    // AWS::Lambda::EventSourceMapping does not support the Tags property in
    // GovCloud. Strip it there so the template validates; commercial output is
    // untouched.
    if (isGovCloud(scope)) {
      for (const child of props.lambdaFunction.node.findAll()) {
        if (child instanceof CfnEventSourceMapping) {
          child.addPropertyDeletionOverride("Tags");
        }
      }
    }

    kmsKey.grantEncryptDecrypt(new ServicePrincipal("events.amazonaws.com"));
    kmsKey.grantEncryptDecrypt(new ServicePrincipal("sqs.amazonaws.com"));
  }
}
