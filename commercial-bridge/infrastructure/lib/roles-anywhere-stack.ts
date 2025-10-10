// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rolesanywhere from 'aws-cdk-lib/aws-rolesanywhere';
import { Construct } from 'constructs';

export type CaType = 'SELF_SIGNED' | 'PCA';

export interface RolesAnywhereStackProps extends cdk.StackProps {
  /**
   * Type of Certificate Authority to use
   * - SELF_SIGNED: Use external self-signed CA certificate (free, requires manual cert management)
   * - PCA: Use AWS Private Certificate Authority (~$400/month, automated cert management)
   */
  caType: CaType;

  /**
   * For SELF_SIGNED: PEM-encoded CA certificate content
   * For PCA: Not used
   */
  caCertificatePem?: string;

  /**
   * For PCA: ARN of AWS Private CA
   * For SELF_SIGNED: Not used
   */
  pcaArn?: string;

  /**
   * ARN of API Gateway to grant invoke permissions
   */
  apiGatewayArn: string;

  /**
   * Common Name (CN) to restrict in certificate subject
   * This CN must be present in client certificates
   * @default 'govcloud-commercial-bridge'
   */
  allowedCertificateCN?: string;
}

/**
 * Stack that sets up IAM Roles Anywhere for certificate-based authentication
 * to Commercial Bridge APIs from external systems (GovCloud Lambda, CI/CD, etc.)
 *
 * Supports two CA modes:
 * 1. SELF_SIGNED: Free, requires manual certificate management
 * 2. PCA: AWS Private CA with automated cert lifecycle (~$400/month)
 *
 * @example
 * // Using self-signed CA
 * new RolesAnywhereStack(app, 'RolesAnywhere', {
 *   caType: 'SELF_SIGNED',
 *   caCertificatePem: fs.readFileSync('ca.pem', 'utf-8'),
 *   apiGatewayArn: 'arn:aws:execute-api:...',
 * });
 *
 * @example
 * // Using AWS Private CA
 * new RolesAnywhereStack(app, 'RolesAnywhere', {
 *   caType: 'PCA',
 *   pcaArn: 'arn:aws:acm-pca:us-east-1:123456789012:certificate-authority/...',
 *   apiGatewayArn: 'arn:aws:execute-api:...',
 * });
 */
export class RolesAnywhereStack extends cdk.Stack {
  public readonly trustAnchor: rolesanywhere.CfnTrustAnchor;
  public readonly profile: rolesanywhere.CfnProfile;
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: RolesAnywhereStackProps) {
    super(scope, id, props);

    // Validate props based on CA type
    if (props.caType === 'SELF_SIGNED' && !props.caCertificatePem) {
      throw new Error('caCertificatePem is required when caType is SELF_SIGNED');
    }
    if (props.caType === 'PCA' && !props.pcaArn) {
      throw new Error('pcaArn is required when caType is PCA');
    }

    const allowedCN = props.allowedCertificateCN || 'govcloud-commercial-bridge';

    // 1. Create Trust Anchor (conditional based on CA type)
    this.trustAnchor = new rolesanywhere.CfnTrustAnchor(this, 'TrustAnchor', {
      name: 'CommercialBridge-TrustAnchor',
      enabled: true, // Enable trust anchor on creation
      source: props.caType === 'SELF_SIGNED'
        ? {
            // Self-signed: Provide external certificate bundle
            sourceType: 'CERTIFICATE_BUNDLE',
            sourceData: {
              x509CertificateData: props.caCertificatePem!,
            },
          }
        : {
            // PCA: Reference AWS Private CA ARN
            sourceType: 'AWS_ACM_PCA',
            sourceData: {
              acmPcaArn: props.pcaArn!,
            },
          },
    });

    // 2. Create IAM Role for Roles Anywhere
    this.role = new iam.Role(this, 'RolesAnywhereRole', {
      roleName: 'CommercialBridge-RolesAnywhere',
      assumedBy: new iam.ServicePrincipal('rolesanywhere.amazonaws.com'),
      description: 'Role for external systems to access Commercial Bridge APIs via IAM Roles Anywhere',
    });

    // Add trust policy condition to restrict by trust anchor and certificate CN
    const cfnRole = this.role.node.defaultChild as iam.CfnRole;
    cfnRole.assumeRolePolicyDocument = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Service: 'rolesanywhere.amazonaws.com',
          },
          Action: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
          Condition: {
            ArnEquals: {
              'aws:SourceArn': this.trustAnchor.attrTrustAnchorArn,
            },
            StringEquals: {
              // Restrict to specific certificate CN
              'aws:PrincipalTag/x509Subject/CN': allowedCN,
            },
          },
        },
      ],
    };

    // Grant permission to invoke API Gateway
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [
          `${props.apiGatewayArn}/*`, // All methods and stages
        ],
      }),
    );

    // 3. Create IAM Roles Anywhere Profile
    this.profile = new rolesanywhere.CfnProfile(this, 'Profile', {
      name: 'CommercialBridge-Profile',
      enabled: true, // Enable profile on creation
      roleArns: [this.role.roleArn],
      durationSeconds: 3600, // 1 hour (min: 900, max: 43200)
    });

    // Add tags for identification
    cdk.Tags.of(this).add('CAType', props.caType);
    cdk.Tags.of(this).add('Component', 'RolesAnywhere');

    // Outputs
    new cdk.CfnOutput(this, 'CAType', {
      value: props.caType,
      description: 'Certificate Authority type (SELF_SIGNED or PCA)',
    });

    new cdk.CfnOutput(this, 'TrustAnchorArn', {
      value: this.trustAnchor.attrTrustAnchorArn,
      description: 'IAM Roles Anywhere Trust Anchor ARN',
      exportName: 'CommercialBridge-TrustAnchorArn',
    });

    new cdk.CfnOutput(this, 'ProfileArn', {
      value: this.profile.attrProfileArn,
      description: 'IAM Roles Anywhere Profile ARN',
      exportName: 'CommercialBridge-ProfileArn',
    });

    new cdk.CfnOutput(this, 'RoleArn', {
      value: this.role.roleArn,
      description: 'IAM Role ARN for Roles Anywhere',
      exportName: 'CommercialBridge-RoleArn',
    });

    new cdk.CfnOutput(this, 'AllowedCertificateCN', {
      value: allowedCN,
      description: 'Required CN in client certificates',
    });

    // Conditional outputs
    if (props.caType === 'SELF_SIGNED') {
      new cdk.CfnOutput(this, 'ClientCertGenerationCommand', {
        value: `npm run roles-anywhere:generate-client-cert`,
        description: 'Command to generate client certificates',
      });
    }
  }
}
