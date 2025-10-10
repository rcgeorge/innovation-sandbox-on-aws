# AWS Private CA Setup for IAM Roles Anywhere

This guide explains how to deploy and use AWS Private Certificate Authority (PCA) with IAM Roles Anywhere for secure, certificate-based authentication to the Commercial Bridge APIs.

## Overview

**AWS Private CA** provides a managed certificate authority that eliminates the need for self-signed certificates and manual CA key management. When combined with IAM Roles Anywhere, it enables GovCloud Lambdas to authenticate to Commercial AWS using temporary credentials.

### PCA vs Self-Signed Comparison

| Feature | Self-Signed (Free) | AWS PCA (~$400/month) |
|---------|-------------------|----------------------|
| **Cost** | $0/month | ~$400/month |
| **CA Management** | Manual (OpenSSL, local keys) | Automated (AWS-managed) |
| **Cert Issuance** | Manual OpenSSL commands | API-based, programmatic |
| **Revocation** | Manual CRL updates | Automated CRL/OCSP |
| **Audit Trail** | Local logs only | CloudTrail logs |
| **Compliance** | DIY | AWS compliance certifications |
| **Security** | CA key stored locally | CA key secured by AWS |
| **Rotation** | Manual script | Manual trigger (automatable) |

### When to Use PCA

**Choose PCA if:**
- ✅ Production environment requiring compliance (SOC 2, PCI-DSS, FedRAMP)
- ✅ Budget allows ~$400/month for security infrastructure
- ✅ Need centralized certificate management
- ✅ Want automated revocation capabilities
- ✅ Require CloudTrail audit of all cert operations
- ✅ Multiple teams need to issue certificates

**Stick with Self-Signed if:**
- ✅ Development/testing environment
- ✅ Cost-sensitive deployment
- ✅ Low certificate volume (< 10 certs)
- ✅ Comfortable with OpenSSL and manual processes

## Architecture

```
Commercial Account (us-east-1):
  ┌─────────────────────────────┐
  │ PCA Stack                   │
  │ - Private CA (ROOT)         │
  │ - S3 Bucket (CRL storage)   │
  │ - Issues client certificates│
  └─────────────────────────────┘
              ↓
  ┌─────────────────────────────┐
  │ RolesAnywhere Stack         │
  │ - Trust Anchor (→ PCA)      │
  │ - IAM Role                  │
  │ - Profile                   │
  └─────────────────────────────┘
              ↓
  ┌─────────────────────────────┐
  │ API Gateway (IAM Auth)      │
  └─────────────────────────────┘

GovCloud Account (us-gov-east-1):
  ┌─────────────────────────────┐
  │ Secrets Manager             │
  │ - Client cert (base64)      │
  │ - Client key (base64)       │
  └─────────────────────────────┘
              ↓
  ┌─────────────────────────────┐
  │ Lambda Function             │
  │ - Reads cert from SM        │
  │ - Calls credential helper   │
  │ - Gets temp credentials     │
  │ - Signs API requests (SigV4)│
  └─────────────────────────────┘
```

## Prerequisites

1. **AWS Accounts**
   - Commercial account with AWS CLI access
   - GovCloud account with Secrets Manager access

2. **AWS Credentials**
   - Commercial: `AWS_COMMERCIAL_PROFILE` configured
   - GovCloud: `AWS_GOVCLOUD_PROFILE` configured

3. **Software**
   - Node.js 20+
   - OpenSSL (for CSR generation)
   - AWS CLI

4. **Cost Awareness**
   - PCA costs ~$400/month while active
   - Each issued certificate: $0.75
   - CRL storage: ~$0.50/month

## Deployment Steps

### Step 1: Configure Environment Variables

Add to your `.env` file:

```bash
# AWS Credentials
AWS_COMMERCIAL_PROFILE=commercial
AWS_GOVCLOUD_PROFILE=govcloud

# Enable PCA
ENABLE_PCA=true

# PCA Configuration (Optional - uses defaults if not set)
PCA_CA_COMMON_NAME="Commercial Bridge Root CA"
PCA_CA_ORGANIZATION="Innovation Sandbox"
PCA_CA_VALIDITY_DAYS="3650"

# GovCloud Secret Configuration
GOVCLOUD_SECRET_NAME="/InnovationSandbox/CommercialBridge/ClientCert"
GOVCLOUD_REGION="us-gov-east-1"

# Client Certificate Configuration
CERT_VALIDITY_DAYS="365"
```

### Step 2: Deploy PCA Stack

```bash
# From repository root
npm run commercial:deploy

# Or directly from commercial-bridge
cd commercial-bridge
npm run deploy
```

This creates:
- **Private CA** - ROOT certificate authority
- **S3 Bucket** - For Certificate Revocation Lists (CRL)
- **CA Certificate** - Self-signed root certificate (10 year validity)

**Cost starts here: ~$400/month**

**Stack Outputs:**
```
PcaArn: arn:aws:acm-pca:us-east-1:ACCOUNT:certificate-authority/xxx
CrlBucketName: commercial-bridge-pca-crl-ACCOUNT
NextSteps: Run: npm run commercial:pca:issue-client-cert
```

### Step 3: Issue Client Certificate from PCA

**Option A: Issue certificate only (save locally)**

```bash
# From repository root
npm run commercial:pca:issue-client-cert

# Or with custom name
npm run commercial:pca:issue-client-cert -- my-client-name
```

This will:
1. Generate 2048-bit RSA private key
2. Create Certificate Signing Request (CSR)
3. Submit CSR to PCA for signing
4. Wait for certificate issuance (~2-5 seconds)
5. Save files to `commercial-bridge/certs/`:
   - `govcloud-commercial-bridge.pem` (certificate)
   - `govcloud-commercial-bridge.key` (private key, mode 0400)
   - `govcloud-commercial-bridge-chain.pem` (CA chain)

**Option B: Issue and automatically update GovCloud Secrets Manager**

```bash
# Issues cert AND updates GovCloud secret in one command
npm run commercial:pca:issue-and-update-secret
```

This does everything from Option A plus:
- Base64 encodes cert and key
- Updates (or creates) GovCloud Secrets Manager secret
- Returns secret ARN for Lambda configuration

**Note:** Requires GovCloud credentials configured (`AWS_GOVCLOUD_PROFILE`)

### Step 4: Deploy IAM Roles Anywhere Stack with PCA

```bash
# Configure to use PCA
export ENABLE_ROLES_ANYWHERE=true
export ROLES_ANYWHERE_CA_TYPE=PCA
# PCA ARN automatically detected from PcaStack output

# Deploy
npm run commercial:deploy
```

This creates:
- **Trust Anchor** - Points to PCA (not self-signed cert)
- **IAM Role** - Grants API Gateway invoke permissions
- **Profile** - Maps certificates to role (1 hour sessions)

**Stack Outputs:**
```
TrustAnchorArn: arn:aws:rolesanywhere:us-east-1:ACCOUNT:trust-anchor/xxx
ProfileArn: arn:aws:rolesanywhere:us-east-1:ACCOUNT:profile/xxx
RoleArn: arn:aws:iam::ACCOUNT:role/CommercialBridge-RolesAnywhere
```

### Step 5: Configure GovCloud Lambda

Update your GovCloud Lambda environment variables (via `.env` or CloudFormation):

```bash
# Commercial Bridge Configuration
COMMERCIAL_BRIDGE_API_URL=https://xxx.execute-api.us-east-1.amazonaws.com/prod

# IAM Roles Anywhere Configuration (replaces API key)
COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN=arn:aws-us-gov:secretsmanager:us-gov-east-1:ACCOUNT:secret:/InnovationSandbox/CommercialBridge/ClientCert-xxxxx
COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN=arn:aws:rolesanywhere:us-east-1:ACCOUNT:trust-anchor/xxx
COMMERCIAL_BRIDGE_PROFILE_ARN=arn:aws:rolesanywhere:us-east-1:ACCOUNT:profile/xxx
COMMERCIAL_BRIDGE_ROLE_ARN=arn:aws:iam::ACCOUNT:role/CommercialBridge-RolesAnywhere

# Remove or comment out (if migrating from API key)
# COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN=...
```

### Step 6: Attach Roles Anywhere Lambda Layer

Your GovCloud Lambda needs the IAM Roles Anywhere credential helper binary:

```typescript
// In your CDK stack
import { RolesAnywhereHelperLayer } from '@amzn/innovation-sandbox-infrastructure/components/lambda-layers';

const layer = new RolesAnywhereHelperLayer(this, 'RolesAnywhereLayer', {
  namespace: props.namespace,
});

const lambda = new lambda.Function(this, 'MyLambda', {
  // ...
  layers: [layer],
});
```

The layer provides `/opt/bin/aws_signing_helper` binary.

### Step 7: Test Authentication

Test from GovCloud Lambda or local system:

```bash
# Test certificate authentication
aws lambda invoke \
  --function-name your-govcloud-function \
  --payload '{"test": true}' \
  response.json \
  --region us-gov-east-1 \
  --profile govcloud

# Check Lambda logs for:
# "CommercialBridgeClient using IAM Roles Anywhere authentication"
# "IAM Roles Anywhere credentials obtained"
```

## Certificate Management

### Viewing Certificate Details

```bash
# View certificate info
openssl x509 -in commercial-bridge/certs/govcloud-commercial-bridge.pem -noout -text

# Check expiration
openssl x509 -in commercial-bridge/certs/govcloud-commercial-bridge.pem -noout -enddate

# Verify certificate chain
openssl verify -CAfile commercial-bridge/certs/govcloud-commercial-bridge-chain.pem \
  commercial-bridge/certs/govcloud-commercial-bridge.pem
```

### Certificate Rotation (Annual)

**When to rotate:**
- Before certificate expires (recommended: 30 days before)
- After suspected compromise
- As part of security hygiene (even if not expired)

**How to rotate:**

```bash
# 1. Issue new certificate from PCA
npm run commercial:pca:issue-and-update-secret

# 2. Done! GovCloud Secrets Manager updated
# 3. Lambda automatically uses new cert on next cold start

# 4. Optional: Force Lambda to pick up new cert immediately
aws lambda update-function-configuration \
  --function-name your-function \
  --environment Variables={FORCE_REFRESH=true} \
  --region us-gov-east-1
```

**Zero-downtime rotation:**
- Issue new cert before old expires
- Update Secrets Manager
- Lambda picks up new cert on next execution
- Old cert expires harmlessly

### Revoking Certificates

```bash
# If certificate is compromised, revoke it
aws acm-pca revoke-certificate \
  --certificate-authority-arn arn:aws:acm-pca:us-east-1:ACCOUNT:certificate-authority/xxx \
  --certificate-serial <SERIAL_FROM_CERT> \
  --revocation-reason KEY_COMPROMISE \
  --region us-east-1 \
  --profile commercial

# Issue replacement certificate immediately
npm run commercial:pca:issue-and-update-secret
```

## Monitoring and Audit

### CloudTrail Events to Monitor

```bash
# Certificate issuance
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=IssueCertificate \
  --region us-east-1 \
  --profile commercial

# Certificate revocation
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=RevokeCertificate \
  --region us-east-1 \
  --profile commercial

# IAM Roles Anywhere credential retrieval
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=CreateSession \
  --region us-east-1 \
  --profile commercial
```

### PCA Audit Report

```bash
# List all issued certificates
aws acm-pca list-certificates \
  --certificate-authority-arn arn:aws:acm-pca:us-east-1:ACCOUNT:certificate-authority/xxx \
  --region us-east-1 \
  --profile commercial

# Get CA details
aws acm-pca describe-certificate-authority \
  --certificate-authority-arn arn:aws:acm-pca:us-east-1:ACCOUNT:certificate-authority/xxx \
  --region us-east-1 \
  --profile commercial
```

## Troubleshooting

### "PcaStack not found"

**Error:** `PcaStack not found. Deploy it first`

**Solution:**
```bash
export ENABLE_PCA=true
npm run commercial:deploy
```

### "CertificateAuthorityInvalidStateException"

**Error:** `The certificate authority XXXX is not in a valid state for issuing certificates`

**Cause:** PCA is not activated yet (happens during initial deployment)

**Solution:** Wait 1-2 minutes for CA activation to complete, then retry:
```bash
npm run commercial:pca:issue-client-cert
```

### "RequestInProgressException"

**Error:** Certificate issuance times out

**Solution:** Check PCA console for certificate status:
```bash
aws acm-pca get-certificate \
  --certificate-authority-arn $PCA_ARN \
  --certificate-arn $CERT_ARN \
  --region us-east-1 \
  --profile commercial
```

### "AccessDeniedException" from GovCloud Lambda

**Error:** Lambda cannot access Commercial Bridge API

**Possible causes:**
1. Certificate not in GovCloud Secrets Manager
2. Trust Anchor not using PCA ARN
3. Certificate CN doesn't match `ROLES_ANYWHERE_ALLOWED_CN`
4. Credential helper binary missing

**Debug steps:**
```bash
# 1. Verify secret exists in GovCloud
aws secretsmanager describe-secret \
  --secret-id /InnovationSandbox/CommercialBridge/ClientCert \
  --region us-gov-east-1 \
  --profile govcloud

# 2. Check certificate CN matches allowed value
openssl x509 -in commercial-bridge/certs/govcloud-commercial-bridge.pem -noout -subject
# Should show: CN=govcloud-commercial-bridge

# 3. Verify credential helper exists in Lambda layer
# Check /opt/bin/aws_signing_helper in Lambda environment

# 4. Check CloudTrail for denied assume role attempts
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRole \
  --region us-east-1 \
  --profile commercial | grep -A 20 "errorCode"
```

## Cost Management

### PCA Pricing (as of 2025)

- **Private CA (active):** $400/month
- **Certificate issuance:** $0.75/certificate
- **S3 CRL storage:** ~$0.50/month
- **API calls:** Negligible

**Annual cost for typical usage:**
- 1 PCA: $4,800/year
- 12 cert rotations: $9/year
- **Total: ~$4,809/year**

### Cost Optimization Tips

1. **Delete when not needed:**
   ```bash
   npm run commercial:destroy
   ```
   Deletes PCA and stops charges (can't recover CA private key)

2. **Use short-lived certificates:**
   - Issue 30-day certs instead of 365-day
   - Rotate more frequently (same $0.75 cost)
   - Reduces exposure window

3. **Share PCA across projects:**
   - One PCA can issue certs for multiple use cases
   - Issue different certs with different CNs
   - Amortize $400/month across multiple systems

## Migration from Self-Signed to PCA

### Zero-Downtime Migration

**Step 1: Deploy PCA (non-disruptive)**
```bash
export ENABLE_PCA=true
npm run commercial:deploy
```
Self-signed auth continues to work.

**Step 2: Issue PCA client cert (parallel)**
```bash
npm run commercial:pca:issue-and-update-secret
```
Creates new secret entry, doesn't affect existing.

**Step 3: Update RolesAnywhere to PCA Trust Anchor**
```bash
export ROLES_ANYWHERE_CA_TYPE=PCA
npm run commercial:deploy
```
Updates Trust Anchor to use PCA instead of self-signed.

**Step 4: Update GovCloud Lambda config**
Point Lambda to new secret with PCA-issued cert.

**Step 5: Test**
Verify Lambda can authenticate with PCA cert.

**Step 6: Cleanup (optional)**
Remove self-signed CA files and old secrets.

## Security Considerations

### PCA Security Benefits

1. **CA Key Protected by AWS HSMs** - No local CA key exposure risk
2. **Revocation Support** - Revoke compromised certs instantly
3. **Audit Trail** - CloudTrail logs all cert operations
4. **Compliance** - PCA meets SOC, PCI, FedRAMP requirements
5. **Separation of Duties** - PCA admin ≠ cert requester

### Best Practices

1. ✅ **Enable CRL** - Allows certificate revocation checking
2. ✅ **Short certificate validity** - 90-365 days max
3. ✅ **Monitor CloudTrail** - Alert on unexpected cert issuance
4. ✅ **Backup PCA** - Export CA certificate for disaster recovery
5. ✅ **Rotate regularly** - Even before expiration
6. ✅ **Use unique CNs** - Different systems = different certificates

### Backup and Disaster Recovery

```bash
# Backup PCA CA certificate (do this after initial deployment)
aws acm-pca get-certificate-authority-certificate \
  --certificate-authority-arn $PCA_ARN \
  --output text \
  --region us-east-1 \
  --profile commercial > pca-ca-backup.pem

# Store securely (encrypted, off-site)
# This allows recreating Trust Anchor if PCA is deleted
```

## Next Steps

After completing PCA setup:

1. **Test end-to-end:**
   ```bash
   # Invoke GovCloud Lambda that calls Commercial Bridge
   # Verify CloudTrail shows Roles Anywhere session creation
   ```

2. **Set up rotation reminder:**
   ```bash
   # Add calendar reminder 1 month before expiration
   # Or implement Phase 2: Automated rotation (EventBridge + Lambda)
   ```

3. **Monitor costs:**
   ```bash
   # Check AWS Cost Explorer for PCA charges
   # Verify it's within budget
   ```

4. **Document for team:**
   - Share PCA ARN
   - Document rotation process
   - Train team on troubleshooting

## Cleanup

**To remove PCA and stop charges:**

```bash
# WARNING: This deletes the CA permanently
# You cannot recover the CA private key after deletion

npm run commercial:destroy

# Or destroy just PCA stack
cd commercial-bridge/infrastructure
cdk destroy PcaStack --profile commercial
```

**Before deleting:**
1. Ensure no systems are using PCA-issued certificates
2. Revoke all outstanding certificates
3. Backup CA certificate if needed for forensics

## Support and Resources

- **AWS PCA Documentation:** https://docs.aws.amazon.com/privateca/
- **IAM Roles Anywhere:** https://docs.aws.amazon.com/rolesanywhere/
- **Cost Calculator:** https://calculator.aws/#/addService/ACMPCA
- **Credential Helper:** https://github.com/aws/rolesanywhere-credential-helper

## Appendix: Manual PCA Operations

### Manually Issue Certificate (without script)

```bash
# 1. Generate private key
openssl genrsa -out client.key 2048

# 2. Create CSR
openssl req -new -key client.key -out client.csr \
  -subj "/C=US/O=Innovation Sandbox/OU=Commercial Bridge Client/CN=govcloud-commercial-bridge"

# 3. Submit to PCA
PCA_ARN=<from stack outputs>
CERT_ARN=$(aws acm-pca issue-certificate \
  --certificate-authority-arn $PCA_ARN \
  --csr fileb://client.csr \
  --signing-algorithm SHA256WITHRSA \
  --validity Value=365,Type=DAYS \
  --template-arn arn:aws:acm-pca:::template/EndEntityCertificate/V1 \
  --query CertificateArn \
  --output text \
  --region us-east-1 \
  --profile commercial)

# 4. Wait and retrieve
sleep 5
aws acm-pca get-certificate \
  --certificate-authority-arn $PCA_ARN \
  --certificate-arn $CERT_ARN \
  --query Certificate \
  --output text \
  --region us-east-1 \
  --profile commercial > client.pem

# 5. Update GovCloud secret
CERT_B64=$(base64 -w0 client.pem)
KEY_B64=$(base64 -w0 client.key)

aws secretsmanager update-secret \
  --secret-id /InnovationSandbox/CommercialBridge/ClientCert \
  --secret-string "{\"cert\":\"$CERT_B64\",\"key\":\"$KEY_B64\"}" \
  --region us-gov-east-1 \
  --profile govcloud
```
