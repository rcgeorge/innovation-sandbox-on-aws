#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Script to issue client certificates from AWS Private CA for IAM Roles Anywhere
 *
 * This script:
 * 1. Generates a private key and CSR for the client certificate
 * 2. Requests a certificate from AWS Private CA
 * 3. Retrieves the issued certificate
 * 4. Optionally updates GovCloud Secrets Manager with the certificate
 *
 * Usage:
 *   tsx scripts/issue-client-cert-from-pca.ts [client-name] [--update-secret]
 *
 * Prerequisites:
 * - PCA Stack must be deployed (npm run commercial:deploy with ENABLE_PCA=true)
 * - AWS credentials configured for commercial account
 */

import {
  ACMPCAClient,
  IssueCertificateCommand,
  GetCertificateCommand,
  DescribeCertificateAuthorityCommand,
} from '@aws-sdk/client-acm-pca';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  UpdateSecretCommand,
  DescribeSecretCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { fromIni } from '@aws-sdk/credential-providers';
import * as x509 from '@peculiar/x509';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

interface CertificateData {
  privateKey: string;
  certificate: string;
  certificateChain: string;
}

class PcaCertificateIssuer {
  private pcaClient: ACMPCAClient;
  private cfnClient: CloudFormationClient;

  constructor(
    private region: string = 'us-east-1',
    private govCloudRegion: string = 'us-gov-east-1',
  ) {
    this.pcaClient = new ACMPCAClient({ region: this.region });
    this.cfnClient = new CloudFormationClient({ region: this.region });
  }

  /**
   * Get PCA ARN from CloudFormation outputs
   */
  async getPcaArn(): Promise<string> {
    try {
      const response = await this.cfnClient.send(
        new DescribeStacksCommand({ StackName: 'CommercialBridge-PCA' }),
      );

      const stack = response.Stacks?.[0];
      const pcaArnOutput = stack?.Outputs?.find((o) => o.OutputKey === 'PcaArn');

      if (!pcaArnOutput?.OutputValue) {
        throw new Error(
          'PCA ARN not found in stack outputs. Ensure CommercialBridge-PCA is deployed with ENABLE_PCA=true',
        );
      }

      return pcaArnOutput.OutputValue;
    } catch (error: any) {
      if (error.name === 'ValidationError') {
        throw new Error(
          'CommercialBridge-PCA stack not found. Deploy it first:\n' +
            '  Set ENABLE_PCA=true in .env\n' +
            '  npm run commercial:deploy',
        );
      }
      throw error;
    }
  }

  /**
   * Sanitize common name to prevent command injection
   * Only allows alphanumeric, hyphens, underscores, and dots
   */
  private sanitizeCommonName(commonName: string): string {
    // Remove any characters that could be used for command injection
    const sanitized = commonName.replace(/[^a-zA-Z0-9._-]/g, '');

    if (sanitized !== commonName) {
      console.warn(`⚠️  Common name sanitized: "${commonName}" → "${sanitized}"`);
    }

    if (!sanitized || sanitized.length === 0) {
      throw new Error('Invalid common name: must contain at least one alphanumeric character');
    }

    if (sanitized.length > 64) {
      throw new Error('Invalid common name: exceeds maximum length of 64 characters');
    }

    return sanitized;
  }

  /**
   * Generate RSA private key and CSR using pure Node.js (no OpenSSL required)
   */
  async generateKeyAndCSR(commonName: string): Promise<{ privateKey: string; csr: string }> {
    // Sanitize input to prevent command injection
    const sanitizedCN = this.sanitizeCommonName(commonName);

    console.log(`\n🔐 Generating private key for ${sanitizedCN}...`);

    // Generate 2048-bit RSA key pair
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    });

    console.log('✅ Private key generated');

    // Create CSR using @peculiar/x509 (cross-platform, no OpenSSL needed)
    console.log('📝 Generating Certificate Signing Request (CSR)...');

    // Import the private key for CSR generation
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      Buffer.from(privateKey.replace(/-----BEGIN PRIVATE KEY-----\n|\n-----END PRIVATE KEY-----/g, ''), 'base64'),
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      true,
      ['sign']
    );

    // Create CSR with subject information
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
      name: `CN=${sanitizedCN}, OU=Commercial Bridge Client, O=Innovation Sandbox, C=US`,
      keys: {
        privateKey: cryptoKey,
        publicKey: await crypto.subtle.importKey(
          'spki',
          Buffer.from(publicKey.replace(/-----BEGIN PUBLIC KEY-----\n|\n-----END PUBLIC KEY-----/g, ''), 'base64'),
          {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-256',
          },
          true,
          ['verify']
        ),
      },
      signingAlgorithm: {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
    });

    // Export CSR to PEM format
    const csrPem = csr.toString('pem');
    console.log('✅ CSR generated (using pure Node.js - no OpenSSL required)');

    return { privateKey, csr: csrPem };
  }

  /**
   * Issue certificate from PCA
   */
  async issueCertificate(
    pcaArn: string,
    csr: string,
    validityDays: number = 365,
  ): Promise<string> {
    console.log(`\n📜 Issuing certificate from PCA...`);
    console.log(`   PCA ARN: ${pcaArn}`);
    console.log(`   Validity: ${validityDays} days`);

    const response = await this.pcaClient.send(
      new IssueCertificateCommand({
        CertificateAuthorityArn: pcaArn,
        Csr: Buffer.from(csr),
        SigningAlgorithm: 'SHA256WITHRSA',
        Validity: {
          Type: 'DAYS',
          Value: validityDays,
        },
        // Use EndEntityCertificate template for client certificates
        TemplateArn: 'arn:aws:acm-pca:::template/EndEntityCertificate/V1',
      }),
    );

    if (!response.CertificateArn) {
      throw new Error('Failed to issue certificate - no ARN returned');
    }

    console.log(`✅ Certificate issued: ${response.CertificateArn}`);
    return response.CertificateArn;
  }

  /**
   * Wait for certificate to be issued and retrieve it
   */
  async getCertificate(
    pcaArn: string,
    certificateArn: string,
    maxRetries: number = 10,
  ): Promise<{ certificate: string; certificateChain: string }> {
    console.log('\n⏳ Waiting for certificate to be issued...');

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await this.pcaClient.send(
          new GetCertificateCommand({
            CertificateAuthorityArn: pcaArn,
            CertificateArn: certificateArn,
          }),
        );

        if (response.Certificate && response.CertificateChain) {
          console.log('✅ Certificate retrieved');
          return {
            certificate: response.Certificate,
            certificateChain: response.CertificateChain,
          };
        }
      } catch (error: any) {
        if (error.name === 'RequestInProgressException') {
          console.log(`   Retry ${i + 1}/${maxRetries}...`);
          await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      'Certificate issuance timed out. Check PCA console for status.',
    );
  }

  /**
   * Save certificate files locally
   */
  saveCertificateFiles(
    clientName: string,
    certData: CertificateData,
  ): { certPath: string; keyPath: string; chainPath: string } {
    const certsDir = path.join(__dirname, '../certs');

    // Create certs directory if it doesn't exist
    if (!fs.existsSync(certsDir)) {
      fs.mkdirSync(certsDir, { recursive: true });
    }

    const certPath = path.join(certsDir, `${clientName}.pem`);
    const keyPath = path.join(certsDir, `${clientName}.key`);
    const chainPath = path.join(certsDir, `${clientName}-chain.pem`);

    // Remove existing files if they exist (especially read-only key file)
    [certPath, keyPath, chainPath].forEach((filePath) => {
      if (fs.existsSync(filePath)) {
        // Change permissions before deleting (Windows compatibility)
        try {
          fs.chmodSync(filePath, 0o600);
        } catch (e) {
          // Ignore chmod errors on Windows
        }
        fs.unlinkSync(filePath);
      }
    });

    fs.writeFileSync(certPath, certData.certificate);
    fs.writeFileSync(keyPath, certData.privateKey);
    fs.writeFileSync(chainPath, certData.certificateChain);

    // Set restrictive permissions on private key (Unix-like systems only)
    try {
      fs.chmodSync(keyPath, 0o400);
    } catch (e) {
      // Windows doesn't support Unix permissions
      console.log('   (Skipping chmod on Windows)');
    }

    console.log('\n💾 Certificate files saved:');
    console.log(`   Certificate: ${certPath}`);
    console.log(`   Private Key: ${keyPath}`);
    console.log(`   CA Chain: ${chainPath}`);

    return { certPath, keyPath, chainPath };
  }

  /**
   * Update GovCloud Secrets Manager with certificate
   * Note: This requires GovCloud credentials to be configured
   */
  async updateGovCloudSecret(
    secretName: string,
    certData: CertificateData,
  ): Promise<string> {
    console.log(`\n🔒 Updating GovCloud Secrets Manager...`);
    console.log(`   Secret: ${secretName}`);
    console.log(`   Region: ${this.govCloudRegion}`);

    // Create GovCloud-specific Secrets Manager client
    // Explicitly use GovCloud profile to avoid using commercial credentials
    const govCloudProfile = process.env.AWS_GOVCLOUD_PROFILE || 'default';
    console.log(`   Using GovCloud profile: ${govCloudProfile}`);

    const govCloudSecretsClient = new SecretsManagerClient({
      region: this.govCloudRegion,
      credentials: fromIni({ profile: govCloudProfile }),
    });

    // Base64 encode cert and key for storage
    const certBase64 = Buffer.from(certData.certificate).toString('base64');
    const keyBase64 = Buffer.from(certData.privateKey).toString('base64');

    const secretString = JSON.stringify({
      cert: certBase64,
      key: keyBase64,
    });

    try {
      // Check if secret exists
      await govCloudSecretsClient.send(
        new DescribeSecretCommand({ SecretId: secretName }),
      );

      // Update existing secret
      await govCloudSecretsClient.send(
        new UpdateSecretCommand({
          SecretId: secretName,
          SecretString: secretString,
        }),
      );

      console.log('✅ Secret updated successfully');
    } catch (error: any) {
      if (error instanceof ResourceNotFoundException) {
        // Create new secret
        const response = await govCloudSecretsClient.send(
          new CreateSecretCommand({
            Name: secretName,
            Description: 'IAM Roles Anywhere client certificate for Commercial Bridge API',
            SecretString: secretString,
          }),
        );

        console.log('✅ Secret created successfully');
        return response.ARN!;
      }
      throw error;
    }

    // Get ARN for existing secret
    const describeResponse = await govCloudSecretsClient.send(
      new DescribeSecretCommand({ SecretId: secretName }),
    );

    return describeResponse.ARN!;
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const clientName = args[0] || 'govcloud-commercial-bridge';
  const updateSecret = args.includes('--update-secret');
  const secretName =
    process.env.GOVCLOUD_SECRET_NAME || '/InnovationSandbox/CommercialBridge/ClientCert';
  const govCloudRegion = process.env.GOVCLOUD_REGION || 'us-gov-east-1';
  const certValidityDays = parseInt(process.env.CERT_VALIDITY_DAYS || '365');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AWS PCA Client Certificate Issuance');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Client Name: ${clientName}`);
  console.log(`Validity: ${certValidityDays} days`);
  console.log(`Update GovCloud Secret: ${updateSecret ? 'Yes' : 'No'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const issuer = new PcaCertificateIssuer('us-east-1', govCloudRegion);

  try {
    // Step 1: Get PCA ARN from CloudFormation
    const pcaArn = await issuer.getPcaArn();
    console.log(`✅ Found PCA: ${pcaArn}`);

    // Step 2: Generate private key and CSR
    const { privateKey, csr } = await issuer.generateKeyAndCSR(clientName);

    // Step 3: Issue certificate from PCA
    const certificateArn = await issuer.issueCertificate(pcaArn, csr, certValidityDays);

    // Step 4: Retrieve issued certificate
    const { certificate, certificateChain } = await issuer.getCertificate(
      pcaArn,
      certificateArn,
    );

    // Step 5: Save certificate files locally
    const certData: CertificateData = {
      privateKey,
      certificate,
      certificateChain,
    };

    const { certPath, keyPath, chainPath } = issuer.saveCertificateFiles(
      clientName,
      certData,
    );

    // Step 6: Optionally update GovCloud Secrets Manager
    let secretArn: string | undefined;
    if (updateSecret) {
      secretArn = await issuer.updateGovCloudSecret(secretName, certData);

      console.log('\n✅ Certificate deployed to GovCloud!');
      console.log(`   Secret ARN: ${secretArn}`);
    }

    // Display next steps
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ SUCCESS - Certificate issued from PCA');
    console.log('═══════════════════════════════════════════════════════════');

    if (!updateSecret) {
      console.log('\n📋 Next Steps:');
      console.log('\n1. Review certificate files:');
      console.log(`   cat ${certPath}`);
      console.log(`   openssl x509 -in ${certPath} -noout -text`);
      console.log('\n2. Update GovCloud Secrets Manager:');
      console.log(`   node scripts/issue-client-cert-from-pca.ts ${clientName} --update-secret`);
      console.log('\n3. Or manually base64 encode and store:');
      console.log(`   CERT_B64=$(base64 -w0 ${certPath})`);
      console.log(`   KEY_B64=$(base64 -w0 ${keyPath})`);
      console.log(
        `   aws secretsmanager update-secret --secret-id ${secretName} --secret-string '{"cert":"$CERT_B64","key":"$KEY_B64"}' --region ${govCloudRegion} --profile govcloud`,
      );
    } else {
      console.log('\n📋 Next Steps:');
      console.log('\n1. Deploy RolesAnywhereStack with PCA trust anchor:');
      console.log('   export ENABLE_ROLES_ANYWHERE=true');
      console.log('   export ROLES_ANYWHERE_CA_TYPE=PCA');
      console.log(`   export ROLES_ANYWHERE_PCA_ARN=${pcaArn}`);
      console.log('   npm run commercial:deploy');
      console.log('\n2. Test from GovCloud Lambda with environment variables:');
      console.log(`   COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN=${secretArn}`);
      console.log('   COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN=<from RolesAnywhereStack outputs>');
      console.log('   COMMERCIAL_BRIDGE_PROFILE_ARN=<from RolesAnywhereStack outputs>');
      console.log('   COMMERCIAL_BRIDGE_ROLE_ARN=<from RolesAnywhereStack outputs>');
    }

    console.log('\n⚠️  Security Notes:');
    console.log(`   - Private key stored at: ${keyPath} (mode 0400)`);
    console.log('   - Never commit certificates to git');
    console.log('   - Rotate certificates before expiration');
    console.log(`   - Certificate expires: ${new Date(Date.now() + certValidityDays * 24 * 60 * 60 * 1000).toISOString()}`);
    console.log('═══════════════════════════════════════════════════════════\n');
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { PcaCertificateIssuer, CertificateData };
