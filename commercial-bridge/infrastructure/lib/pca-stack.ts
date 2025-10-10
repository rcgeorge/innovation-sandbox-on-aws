// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS Private Certificate Authority (PCA) Stack
 *
 * Creates a Private CA for issuing client certificates for IAM Roles Anywhere authentication.
 * This provides centralized certificate management with automated lifecycle controls.
 *
 * Cost: ~$400/month for Private CA + $0.75 per issued certificate
 *
 * Benefits over self-signed:
 * - Centralized CA management (no local ca.key to protect)
 * - Certificate revocation via CRL/OCSP
 * - CloudTrail audit of all cert issuance
 * - Programmatic cert issuance via API
 * - Compliance and security best practices built-in
 */

import * as cdk from 'aws-cdk-lib';
import * as acmpca from 'aws-cdk-lib/aws-acmpca';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface PcaStackProps extends cdk.StackProps {
  /**
   * Common Name for the CA certificate
   * @default 'Commercial Bridge Root CA'
   */
  caCommonName?: string;

  /**
   * Organization name for the CA
   * @default 'Innovation Sandbox'
   */
  caOrganization?: string;

  /**
   * Organizational Unit for the CA
   * @default 'Commercial Bridge'
   */
  caOrganizationalUnit?: string;

  /**
   * CA validity period in days
   * @default 3650 (10 years)
   */
  caValidityDays?: number;

  /**
   * Whether to enable Certificate Revocation List (CRL)
   * @default true
   */
  enableCrl?: boolean;
}

export class PcaStack extends cdk.Stack {
  public readonly ca: acmpca.CfnCertificateAuthority;
  public readonly caCertificate: acmpca.CfnCertificate;
  public readonly crlBucket?: s3.Bucket;

  constructor(scope: Construct, id: string, props?: PcaStackProps) {
    super(scope, id, props);

    const caCommonName = props?.caCommonName || 'Commercial Bridge Root CA';
    const caOrganization = props?.caOrganization || 'Innovation Sandbox';
    const caOrgUnit = props?.caOrganizationalUnit || 'Commercial Bridge';
    const validityDays = props?.caValidityDays || 3650; // 10 years
    const enableCrl = props?.enableCrl ?? true;

    // Create S3 bucket for CRL if enabled
    if (enableCrl) {
      this.crlBucket = new s3.Bucket(this, 'CrlBucket', {
        bucketName: `commercial-bridge-pca-crl-${this.account}`,
        // No encryption - PCA manages CRL object encryption
        blockPublicAccess: new s3.BlockPublicAccess({
          blockPublicAcls: false, // PCA needs to set ACLs
          blockPublicPolicy: false, // PCA needs policy access
          ignorePublicAcls: false,
          restrictPublicBuckets: false,
        }),
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
        versioned: false, // CRL doesn't need versioning
        lifecycleRules: [
          {
            expiration: cdk.Duration.days(90), // CRLs older than 90 days
            enabled: true,
          },
        ],
        removalPolicy: cdk.RemovalPolicy.DESTROY, // Clean up on stack delete
        autoDeleteObjects: true,
      });

      // Grant PCA comprehensive permissions to access CRL bucket
      this.crlBucket.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: 'AllowPCAServiceToPutObjects',
          effect: cdk.aws_iam.Effect.ALLOW,
          principals: [new cdk.aws_iam.ServicePrincipal('acm-pca.amazonaws.com')],
          actions: [
            's3:PutObject',
            's3:PutObjectAcl',
            's3:GetBucketAcl',
            's3:GetBucketLocation',
          ],
          resources: [
            this.crlBucket.bucketArn,
            `${this.crlBucket.bucketArn}/*`,
          ],
        }),
      );
    }

    // Create Private Certificate Authority (depends on S3 bucket policy if CRL enabled)
    this.ca = new acmpca.CfnCertificateAuthority(this, 'PrivateCA', {
      type: 'ROOT',
      keyAlgorithm: 'RSA_2048',
      signingAlgorithm: 'SHA256WITHRSA',
      subject: {
        commonName: caCommonName,
        organization: caOrganization,
        organizationalUnit: caOrgUnit,
        country: 'US',
      },
      revocationConfiguration: enableCrl && this.crlBucket
        ? {
            crlConfiguration: {
              enabled: true,
              expirationInDays: 7, // CRL valid for 7 days
              s3BucketName: this.crlBucket.bucketName,
            },
          }
        : { crlConfiguration: { enabled: false } },
      usageMode: 'GENERAL_PURPOSE', // Supports certificates up to 10 years
    });

    // Ensure PCA is created after bucket policy is applied
    if (enableCrl && this.crlBucket) {
      this.ca.node.addDependency(this.crlBucket);
    }

    // Issue self-signed root certificate for the CA
    this.caCertificate = new acmpca.CfnCertificate(this, 'CACertificate', {
      certificateAuthorityArn: this.ca.attrArn,
      certificateSigningRequest: this.ca.attrCertificateSigningRequest,
      signingAlgorithm: 'SHA256WITHRSA',
      templateArn: 'arn:aws:acm-pca:::template/RootCACertificate/V1',
      validity: {
        type: 'DAYS',
        value: validityDays,
      },
    });

    // Activate the CA by installing the root certificate
    const activateCa = new acmpca.CfnCertificateAuthorityActivation(this, 'CAActivation', {
      certificateAuthorityArn: this.ca.attrArn,
      certificate: this.caCertificate.attrCertificate,
      status: 'ACTIVE',
    });

    // Add tags
    cdk.Tags.of(this).add('Component', 'PCA');
    cdk.Tags.of(this).add('Purpose', 'IAM-Roles-Anywhere');

    // Outputs
    new cdk.CfnOutput(this, 'PcaArn', {
      value: this.ca.attrArn,
      description: 'Private Certificate Authority ARN for IAM Roles Anywhere',
      exportName: 'CommercialBridge-PcaArn',
    });

    new cdk.CfnOutput(this, 'CaCommonName', {
      value: caCommonName,
      description: 'CA Certificate Common Name',
    });

    if (this.crlBucket) {
      new cdk.CfnOutput(this, 'CrlBucketName', {
        value: this.crlBucket.bucketName,
        description: 'S3 bucket for Certificate Revocation Lists',
      });
    }

    new cdk.CfnOutput(this, 'PcaCost', {
      value: '$400/month + $0.75 per certificate',
      description: 'Estimated monthly cost for PCA',
    });

    new cdk.CfnOutput(this, 'NextSteps', {
      value: 'Run: npm run commercial:pca:issue-client-cert',
      description: 'Command to issue client certificates from this PCA',
    });
  }
}
