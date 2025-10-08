# GovCloud Implementation Guide

This document summarizes the changes made to enable Innovation Sandbox on AWS to work in AWS GovCloud regions.

## Overview

Innovation Sandbox was originally designed for commercial AWS regions. This implementation adds full GovCloud support including:
- Multi-partition compatibility (aws vs aws-us-gov)
- Cost tracking via commercial bridge API
- Account cleanup automation
- Service Control Policy (SCP) fixes

---

## Issues Fixed

### 1. Partition Hardcoding Issues

**Problem:** Code hardcoded `arn:aws:` partition, which doesn't exist in GovCloud (`arn:aws-us-gov:`).

**Files Fixed:**

**Step Function - Account Cleaner**
- File: `source/infrastructure/lib/components/account-cleaner/step-function.ts`
- Line 100: Changed `arn:aws:states:::codebuild:startBuild.sync` to `arn:${Stack.of(this).partition}:states:::codebuild:startBuild.sync`
- Lines 129-133: Added `AWS_PARTITION` environment variable passed to CodeBuild

**Buildspec - Account Cleaner**
- File: `source/infrastructure/lib/components/account-cleaner/cleanup-buildspec.yaml`
- Line 30: Changed hardcoded `arn:aws:iam::$CLEANUP_ACCOUNT_ID:...` to `arn:${AWS_PARTITION}:iam::$CLEANUP_ACCOUNT_ID:...`

**Service Control Policies (All SCP files)**
- Files: `source/infrastructure/lib/components/service-control-policies/*.json`
- Changed all `arn:aws:` to `arn:*:` to support both partitions
- Files affected:
  - `isb-deny-all-non-control-plane-actions.json`
  - `isb-aws-nuke-supported-services-scp.json`
  - `isb-limit-managed-regions.json`
  - `isb-protect-control-plane-resource-scp.json`
  - `isb-restrictions-scp.json`

---

### 2. Service Control Policy (SCP) Issues

**Problem 1: WriteProtection SCP on Entry OU**
- SCPs on Entry OU prevented StackSets from creating SandboxAccountRole
- File: `source/infrastructure/lib/isb-account-pool-resources.ts`
- Line 186: Removed `entryOu.attrId` from WriteProtection SCP targets
- Added comment: "Entry OU is intentionally excluded to allow StackSets to create SandboxAccountRole"

**Problem 2: Protect SCP Blocking SandboxAccountRole Creation**
- Original SCP protected all `InnovationSandbox-${namespace}*` roles
- This blocked StackSets from creating SandboxAccountRole in sandbox accounts
- File: `source/infrastructure/lib/components/service-control-policies/isb-protect-control-plane-resource-scp.json`
- Lines 9-11: Changed from wildcard `arn:*:iam::*:role/InnovationSandbox-${namespace}*` to specific roles:
  - `arn:*:iam::*:role/InnovationSandbox-${namespace}-IntermediateRole`
  - `arn:*:iam::*:role/InnovationSandbox-${namespace}-OrgMgtRole`
  - `arn:*:iam::*:role/InnovationSandbox-${namespace}-IdcRole`
- This allows SandboxAccountRole to be created while still protecting hub account roles

**Problem 3: External "Block Backups" SCP**
- Custom SCP at organization root denied `iam:CreateRole` for all accounts except management accounts
- Blocked StackSets from creating roles in sandbox accounts
- Solution: Temporarily detached for testing
- Recommendation: Modify to exclude `arn:*:iam::*:role/stacksets-exec-*` from deny condition

---

## GovCloud Cost Monitoring Implementation

### Problem: Cost Explorer API Not Available in GovCloud

AWS Cost Explorer API is not available in GovCloud regions. Costs for GovCloud accounts appear in the **commercial linked account** under GovCloud regions.

### Solution: Commercial Bridge API

Created a bridge API in commercial AWS that:
1. Receives cost queries from GovCloud
2. Queries Cost Explorer in commercial account
3. Returns cost data to GovCloud

### Architecture

```
GovCloud Lambda (604110488194)
  ↓ HTTPS POST with API key
Commercial Bridge API (890314022608)
  ↓ Queries Cost Explorer
Commercial Account costs (filtered by region: us-gov-east-1, us-gov-west-1)
  ↓ Returns cost data
GovCloud Lambda stores in Lease table
```

### Account Mapping Challenge

GovCloud accounts created via `CreateGovCloudAccount` have a paired commercial account. Costs appear under the **commercial account ID**, not the GovCloud account ID.

**Solution:** Commercial bridge API auto-discovers the mapping:
- Calls `ListCreateAccountStatus` API in commercial account
- Finds GovCloud → Commercial account mapping
- Caches mapping in Lambda execution context (5-min TTL)
- Falls back to manual `commercialLinkedAccountId` if auto-discovery fails

---

## Commercial Bridge API

**Deployed in:** Commercial AWS account 890314022608
**API URL:** https://88c5sges1k.execute-api.us-east-1.amazonaws.com/prod

### Endpoints

**1. POST /cost-info**
```json
Request:
{
  "linkedAccountId": "473888154289",        // GovCloud or commercial account ID
  "startDate": "2025-09-01",
  "endDate": "2025-10-06",
  "granularity": "DAILY",                   // Optional: DAILY or MONTHLY
  "region": "us-gov-east-1",                // Optional: filter by region
  "isGovCloudAccountId": true,              // Triggers mapping lookup
  "commercialAccountId": "890314022608"     // Optional: manual mapping override
}

Response:
{
  "linkedAccountId": "890314022608",        // Commercial account used for query
  "govCloudAccountId": "473888154289",      // GovCloud account (if applicable)
  "commercialAccountId": "890314022608",    // Same as linkedAccountId
  "totalCost": 15.81,
  "currency": "USD",
  "breakdown": [
    { "service": "AWS KMS", "cost": 3.95 },
    ...
  ]
}
```

**Features:**
- ✅ Auto-discovers GovCloud → Commercial mapping via `ListCreateAccountStatus`
- ✅ Supports manual commercial account ID override
- ✅ Multi-region cost filtering
- ✅ Lambda execution context caching (5-min TTL)
- ✅ Secure POST method (credentials in encrypted body)

**2. POST /govcloud-accounts**
```json
Request:
{
  "accountName": "My-GovCloud-Account",
  "email": "user@example.com",              // Auto-aliased with timestamp
  "roleName": "OrganizationAccountAccessRole"  // Optional
}

Response:
{
  "requestId": "car-abc123...",
  "status": "IN_PROGRESS",
  "createTime": "2025-10-07T01:04:33.038Z",
  "message": "Account creation initiated. Check status using GET /govcloud-accounts/{requestId}"
}
```

**Features:**
- ✅ Automatic email aliasing (e.g., `user+govcloud-1728252345@example.com`)
- ✅ Creates paired commercial + GovCloud accounts
- ✅ Returns immediately with requestId

**3. GET /govcloud-accounts/{requestId}**
```json
Response:
{
  "requestId": "car-abc123...",
  "status": "SUCCEEDED",                    // or IN_PROGRESS, FAILED
  "govCloudAccountId": "474553445986",
  "commercialAccountId": "887495603630",
  "createTime": "2025-10-07T01:05:37.295Z"
}
```

**4. POST /govcloud-accounts/accept-invitation** (NEW - Deployed)
```json
Request:
{
  "govCloudAccountId": "474553445986",
  "commercialLinkedAccountId": "887495603630",
  "handshakeId": "h-abc123...",
  "govCloudRegion": "us-gov-east-1"
}

Response:
{
  "status": "ACCEPTED",
  "handshakeId": "h-abc123...",
  "govCloudAccountId": "474553445986",
  "handshakeState": "ACCEPTED"
}
```

**How it works:**
1. Assumes `OrganizationAccountAccessRole` in commercial linked account
2. Uses those credentials to assume role in GovCloud account (cross-partition)
3. Calls GovCloud Organizations API to accept handshake
4. Returns success

---

## GovCloud Innovation Sandbox Changes

### 1. Cost Service Abstraction

**New Interface:**
- File: `source/common/isb-services/cost-service.ts`
- Defines `ICostService` interface for cost retrieval

**Implementations:**
- `CostExplorerService` - Direct AWS SDK (commercial AWS)
- `CommercialBridgeCostService` - Commercial bridge API proxy (GovCloud)

**Factory Pattern:**
- File: `source/common/isb-services/index.ts`
- Function: `IsbServices.costExplorer()`
- Detects GovCloud via `AWS_REGIONS` environment variable
- Returns appropriate implementation
- Fully backwards compatible

### 2. Data Model Updates

**SandboxAccount Schema:**
- File: `source/common/data/sandbox-account/sandbox-account.ts`
- Added optional field: `commercialLinkedAccountId?: string`
- Used for manual mapping when auto-discovery fails
- Backwards compatible (undefined for commercial deployments)

### 3. Lambda Environment Updates

**Lease Monitoring Lambda:**
- File: `source/infrastructure/lib/components/account-management/lease-monitoring-lambda.ts`
- Added environment variables:
  - `ACCOUNT_TABLE_NAME` - For querying account mappings
  - `AWS_REGIONS` - For detecting GovCloud
  - `COMMERCIAL_BRIDGE_API_URL` - Bridge API endpoint
  - `COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN` - API key in Secrets Manager
- Added Secrets Manager read permission
- Added DynamoDB read permission for account table

**Cost Reporting Lambda:**
- File: `source/infrastructure/lib/components/observability/cost-reporting-lambda.ts`
- Same environment variables and permissions as Lease Monitoring

### 4. Infrastructure Configuration

**CDK Context Variables:**
- File: `package.json` - Updated `deploy:compute` script
- Passes context: `--context isbManagedRegions=$AWS_REGIONS --context commercialBridgeApiUrl=$COMMERCIAL_BRIDGE_API_URL --context commercialBridgeApiKeySecretArn=$COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN`

**Environment Variables (.env):**
```bash
# GovCloud-specific configuration
IS_GOVCLOUD="true"
AWS_REGIONS="us-gov-east-1,us-gov-west-1"

# Commercial Bridge API (GovCloud only)
COMMERCIAL_BRIDGE_API_URL="https://88c5sges1k.execute-api.us-east-1.amazonaws.com/prod"
COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN="arn:aws-us-gov:secretsmanager:us-gov-east-1:604110488194:secret:InnovationSandbox/myisb/CommercialBridgeApiKey-jzIcLv"
```

**Secrets Manager:**
```bash
# API key stored in GovCloud Secrets Manager
aws secretsmanager create-secret \
  --name "InnovationSandbox/myisb/CommercialBridgeApiKey" \
  --secret-string "9dixlZcDcC74atSA9QwfE391LL9qhegTkXthEt25" \
  --region us-gov-east-1
```

### 5. Commercial Bridge Client

**File:** `source/common/isb-services/commercial-bridge-client.ts`

**Methods:**
- `queryCost()` - Query cost information
- `createGovCloudAccount()` - Create new GovCloud account
- `getGovCloudAccountStatus()` - Poll creation status
- `acceptInvitation()` - Accept organization invitation

**Features:**
- API key retrieved from Secrets Manager (cached)
- Error handling with custom exceptions
- Logging for observability

### 6. Commercial Bridge Cost Service

**File:** `source/common/isb-services/commercial-bridge-cost-service.ts`

**Key Features:**
- Implements `ICostService` interface
- Queries each GovCloud region separately (us-gov-east-1, us-gov-west-1)
- Aggregates costs across regions
- Uses `commercialLinkedAccountId` from SandboxAccount if available
- Falls back to auto-discovery via commercial bridge
- Graceful error handling (skips accounts without mapping)
- Logs warnings for missing mappings

---

## Testing & Verification

### Cost Monitoring Verification

**Test Command:**
```bash
aws lambda invoke \
  --function-name ISB-CostReportingLambda-myisb \
  --region us-gov-east-1 \
  --payload "{}" \
  response.json
```

**Verified in Logs:**
```
"message":"Querying cost range for 1 accounts via commercial bridge"
"service":"CommercialBridgeCostService"
```

**Result:** ✅ GovCloud Lambda successfully called commercial bridge API and retrieved costs

### Account Cleanup Verification

**Test Account:** 473888154289

**Process:**
1. StackSets deployed SandboxAccountRole ✅
2. Account registered through Innovation Sandbox ✅
3. Moved Entry → CleanUp ✅
4. Cleanup Step Function executed ✅
5. AWS Nuke cleaned account ✅
6. Moved CleanUp → Available ✅

**Result:** ✅ Full account lifecycle automation working in GovCloud

---

## Cross-Partition Account Creation (In Progress)

### Discovery: Special Linked Account Relationship

When `CreateGovCloudAccount` creates paired accounts, a special trust relationship exists:
- Commercial linked account can assume role in its paired GovCloud account
- This works **cross-partition** (commercial → GovCloud)
- Enables automation of organization invitation acceptance

### Verified Via CLI Testing

**Test Results:**
```bash
# Step 1: Commercial mgmt → Commercial linked account
aws sts assume-role \
  --role-arn arn:aws:iam::887495603630:role/OrganizationAccountAccessRole \
  --profile commercial
✅ Success

# Step 2: Commercial linked → GovCloud account (CROSS-PARTITION)
aws sts assume-role \
  --role-arn arn:aws-us-gov:iam::474553445986:role/OrganizationAccountAccessRole
✅ Success (returned GovCloud credentials!)

# Step 3: Use GovCloud credentials to accept invitation
aws organizations accept-handshake \
  --handshake-id h-xxx \
  --region us-gov-east-1
✅ Success (handshake accepted!)
```

**Key Insight:** Cross-partition STS AssumeRole DOES work for the special OrganizationAccountAccessRole relationship between linked commercial/GovCloud accounts.

### Commercial Bridge Implementation

**New Lambda:** `commercial-bridge/lambdas/accept-invitation/src/handler.ts`

**Logic:**
1. Assume OrganizationAccountAccessRole in commercial linked account
2. Use those credentials to assume role in GovCloud account (cross-partition)
3. Create GovCloud Organizations client with GovCloud credentials
4. Call AcceptHandshake API
5. Return success

**IAM Permissions:**
```json
{
  "Effect": "Allow",
  "Action": "sts:AssumeRole",
  "Resource": "arn:*:iam::*:role/OrganizationAccountAccessRole"
}
```

**API Endpoint:** `POST /govcloud-accounts/accept-invitation`

**Status:** ✅ Deployed to commercial account

---

## Deployment Instructions

### Prerequisites

1. **Commercial account setup:**
   - Deploy commercial bridge CDK stacks
   - Get API Gateway URL and API key
   - Note API key for GovCloud configuration

2. **GovCloud secrets setup:**
```bash
aws secretsmanager create-secret \
  --name "InnovationSandbox/${NAMESPACE}/CommercialBridgeApiKey" \
  --description "API key for commercial bridge" \
  --secret-string "<api-key-value>" \
  --region us-gov-east-1
```

3. **Update .env file:**
```bash
IS_GOVCLOUD="true"
AWS_REGIONS="us-gov-east-1,us-gov-west-1"
COMMERCIAL_BRIDGE_API_URL="https://88c5sges1k.execute-api.us-east-1.amazonaws.com/prod"
COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN="arn:aws-us-gov:secretsmanager:us-gov-east-1:604110488194:secret:InnovationSandbox/myisb/CommercialBridgeApiKey-xxxxx"
```

### Deploy GovCloud Stacks

```bash
# 1. Deploy Account Pool (SCP fixes)
npm run deploy:account-pool

# 2. Deploy IDC stack
npm run deploy:idc

# 3. Deploy Data stack (schema updates)
npm run deploy:data

# 4. Deploy Compute stack (cost monitoring integration)
npm run deploy:compute
```

### Manual Account Mapping (For Existing Accounts)

For GovCloud accounts created outside CreateGovCloudAccount API:

```bash
# Add commercial account mapping to DynamoDB
aws dynamodb update-item \
  --table-name <SandboxAccountTableName> \
  --region us-gov-east-1 \
  --key '{"awsAccountId":{"S":"604110488194"}}' \
  --update-expression "SET commercialLinkedAccountId = :commercialId" \
  --expression-attribute-values '{":commercialId":{"S":"890314022608"}}'
```

---

## Cost Monitoring Schedule

**Lease Monitoring Lambda:**
- **Frequency:** Every 1 hour
- **Function:** Queries costs for all Active and Frozen leases
- **Actions:**
  - Updates `totalCostAccrued` in lease records
  - Triggers budget threshold alerts (75%, 90%)
  - Triggers lease freezing when freeze threshold breached
  - Triggers lease termination when budget exceeded or lease expired

**Cost Reporting Lambda:**
- **Frequency:** Monthly (4th of each month at 01:25 UTC)
- **Function:** Generates monthly cost summary
- **Purpose:** Analytics and reporting (not for budget enforcement)

**Manual Trigger:**
```bash
# Test cost monitoring immediately
aws lambda invoke \
  --function-name ISB-LeaseMonitoring-myisb \
  --region us-gov-east-1 \
  --payload "{}" \
  response.json
```

---

## Backwards Compatibility

All changes are **fully backwards compatible** with commercial AWS deployments:

**Detection Logic:**
```typescript
const regions = env.AWS_REGIONS?.split(",") || [];
const isGovCloud = regions.some((r) => r.startsWith("us-gov-"));

if (isGovCloud && env.COMMERCIAL_BRIDGE_API_URL && env.COMMERCIAL_BRIDGE_API_KEY_SECRET_ARN) {
  // Use commercial bridge
  return new CommercialBridgeCostService({...});
} else {
  // Use Cost Explorer SDK (commercial AWS)
  return new CostExplorerService({...});
}
```

**Commercial deployments:**
- ✅ No new environment variables required
- ✅ No code changes in Lambda handlers
- ✅ Cost Explorer SDK used directly
- ✅ All existing tests pass
- ✅ Zero functional impact

---

## Known Issues & Workarounds

### Issue 1: "Block Backups" SCP

**Problem:** Custom SCP at organization root denies `iam:CreateRole` for sandbox accounts
**Impact:** Prevents StackSets from creating SandboxAccountRole
**Workaround:** Temporarily detached during testing
**Permanent Fix:** Modify SCP to exclude `stacksets-exec-*` roles:

```json
{
  "Condition": {
    "StringNotEquals": {
      "aws:PrincipalAccount": ["604110488194", "035942766769"]
    },
    "ArnNotLike": {
      "aws:PrincipalARN": ["arn:*:iam::*:role/stacksets-exec-*"]
    }
  }
}
```

### Issue 2: Tag Filtering Not Supported

**Problem:** Commercial bridge API doesn't support Cost Explorer tag filtering
**Impact:** Solution operating costs vs sandbox costs not separated in GovCloud
**Workaround:** Logged as warning, returns unfiltered costs
**Future Enhancement:** Add tag filtering support to commercial bridge API

---

## Testing Accounts

**Accounts Created During Implementation:**
- GovCloud: 473888154289, Commercial: 543634432345 (✅ Joined org, Available)
- GovCloud: 474542014775, Commercial: 221423659966 (✅ Joined org, tested)
- GovCloud: 474553445986, Commercial: 887495603630 (⏳ Created, not joined)

---

## Future Enhancements

### 1. Automated Account Creation Flow (90% Complete)

**Current Status:**
- ✅ Commercial bridge can create accounts
- ✅ Commercial bridge can accept invitations (deployed)
- ✅ Email aliasing automated
- ⏳ GovCloud orchestrator needs implementation
- ⏳ Frontend UI needs implementation

**Remaining Work:**
- GovCloud Lambda to orchestrate full flow:
  1. Call commercial bridge to create account
  2. Poll for completion
  3. Send invitation from GovCloud org
  4. Call commercial bridge to accept invitation
  5. Move account to Entry OU
  6. Register in Innovation Sandbox
  7. Store commercial account mapping

- Frontend:
  - "Create GovCloud Account" button in AddAccounts page
  - Form modal with account name + email
  - Progress indicators during creation/joining
  - Error handling and status display

### 2. Cost History Tracking

**Potential Enhancement:**
- Create CostHistory table with time-series data
- Store hourly/daily cost snapshots
- Enable trend analysis and forecasting
- Cost breakdown by service/region over time

**Decision:** Not implemented - current lease-level cost tracking is sufficient

---

## Key Learnings

1. **Partition isolation is real** - Most AWS services don't work cross-partition
2. **Exception: Linked account relationship** - Special trust for CreateGovCloudAccount pairs
3. **HTTPS APIs bridge partitions** - Only reliable cross-partition communication
4. **SCPs inherit from parents** - Must check entire OU hierarchy for denies
5. **CloudFormation rejects cross-partition ARNs** - Even if runtime would work
6. **Email aliasing with + works** - AWS accepts `user+alias@domain.com`
7. **Cost data location** - GovCloud costs appear in commercial account billing

---

## Architecture Diagrams

### Cost Monitoring Flow

```
┌─────────────────────────────────────┐
│ GovCloud - Lease Monitoring Lambda  │
│ (Runs hourly)                       │
└─────────────┬───────────────────────┘
              │
              │ 1. Query costs for active leases
              ▼
┌─────────────────────────────────────┐
│ CommercialBridgeCostService         │
│ - Gets commercialLinkedAccountId    │
│ - Calls commercial bridge API       │
└─────────────┬───────────────────────┘
              │
              │ 2. POST /cost-info
              │    (encrypted body)
              ▼
┌─────────────────────────────────────┐
│ Commercial Bridge API (Commercial)  │
│ - Auto-discovers account mapping    │
│ - Queries Cost Explorer             │
└─────────────┬───────────────────────┘
              │
              │ 3. Returns cost data
              ▼
┌─────────────────────────────────────┐
│ GovCloud Lambda                     │
│ - Stores in Lease table             │
│ - Triggers budget alerts if needed  │
└─────────────────────────────────────┘
```

### Account Cleanup Flow

```
┌─────────────────────────────────────┐
│ User Registers Account              │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ Account moves Entry → CleanUp       │
│ CleanAccountRequest event sent      │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ Step Function Triggered             │
│ - Initialize Cleanup Lambda         │
│ - CodeBuild runs AWS Nuke           │
│ - Uses AWS_PARTITION variable       │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ Cleanup Success Event               │
│ Account moves CleanUp → Available   │
└─────────────────────────────────────┘
```

---

## Monitoring & Troubleshooting

### CloudWatch Logs

**Global Log Group:**
```bash
aws logs tail InnovationSandbox-Compute-ISBLogGroupE607F9A7-Vd4Dscdwsanh \
  --region us-gov-east-1 \
  --since 1h \
  --filter-pattern "commercial bridge"
```

**Cleanup Log Group:**
```bash
aws logs tail InnovationSandbox-Compute-ISBLogGroupCleanup485A102F-nNYMoWRLgQEi \
  --region us-gov-east-1 \
  --since 1h
```

### Common Issues

**Cost Monitoring Returns $0:**
- Check if lease has `commercialLinkedAccountId` mapping
- Verify commercial bridge API is accessible from GovCloud
- Check Secrets Manager has valid API key
- Review CloudWatch logs for errors

**Account Stuck in CleanUp:**
- Check Step Function execution status
- Verify SandboxAccountRole exists in sandbox account
- Check SCPs aren't blocking CodeBuild execution
- Review cleanup logs for errors

**StackSets Deployment Fails:**
- Verify SCPs don't block `iam:CreateRole`
- Check account is in Entry OU (not CleanUp or Available)
- Verify WriteProtection SCP not attached to Entry OU
- Check for custom SCPs at root level

---

## Files Created/Modified Summary

### Commercial Bridge (New Project)
```
commercial-bridge/
├── lambdas/
│   ├── cost-information/src/handler.ts          # POST /cost-info
│   ├── create-govcloud-account/src/handler.ts   # POST /govcloud-accounts
│   └── accept-invitation/src/handler.ts         # POST /govcloud-accounts/accept-invitation
├── infrastructure/
│   ├── lib/lambda-stacks.ts                     # Lambda definitions
│   ├── lib/api-gateway-stack.ts                 # API Gateway config
│   └── bin/app.ts                               # CDK app
└── package.json
```

### GovCloud Innovation Sandbox

**New Files:**
```
source/common/isb-services/
├── cost-service.ts                              # ICostService interface
├── commercial-bridge-cost-service.ts            # GovCloud implementation
└── commercial-bridge-client.ts                  # HTTP client wrapper
```

**Modified Files:**
```
source/common/
├── data/sandbox-account/sandbox-account.ts      # Added commercialLinkedAccountId
├── isb-services/cost-explorer-service.ts        # Implements ICostService
├── isb-services/index.ts                        # Factory pattern
└── lambda/environments/
    ├── lease-monitoring-environment.ts          # Added bridge config
    └── cost-reporting-lambda-environment.ts     # Added bridge config

source/infrastructure/
├── lib/components/account-cleaner/
│   ├── step-function.ts                         # Partition fix + AWS_PARTITION var
│   └── cleanup-buildspec.yaml                   # Partition variable usage
├── lib/components/service-control-policies/     # All .json files - partition wildcards
├── lib/components/account-management/
│   └── lease-monitoring-lambda.ts               # Env vars + permissions
├── lib/components/observability/
│   └── cost-reporting-lambda.ts                 # Env vars + permissions
├── lib/isb-account-pool-resources.ts            # Entry OU SCP exclusion
├── lib/isb-compute-resources.ts                 # Pass bridge config
└── lib/isb-compute-stack.ts                     # Read CDK context

package.json                                     # Deploy script context params
.env                                             # Commercial bridge config
```

---

## API Reference

### Commercial Bridge API

**Base URL:** `https://88c5sges1k.execute-api.us-east-1.amazonaws.com/prod`
**Authentication:** API Key via `x-api-key` header
**API Key ID:** `vse8xnfs1m` (retrieve value via AWS CLI)

**Get API Key:**
```bash
aws apigateway get-api-key \
  --api-key vse8xnfs1m \
  --include-value \
  --profile commercial \
  --query 'value' \
  --output text
```

### GovCloud Innovation Sandbox API

**Base URL:** `https://m4mof07ftb.execute-api.us-gov-east-1.amazonaws.com/prod`
**Authentication:** SAML via IAM Identity Center

---

## Production Recommendations

1. **Rotate API keys regularly** - Update Secrets Manager and Usage Plan
2. **Monitor commercial bridge API usage** - Set up CloudWatch alarms for throttling
3. **Set up cross-region failover** - Deploy commercial bridge to multiple regions
4. **Implement API rate limiting per account** - Prevent abuse
5. **Enable API Gateway access logs** - Audit all commercial bridge calls
6. **Set up cost alerts** - Monitor commercial bridge API costs
7. **Document manual mapping process** - For accounts created outside automation
8. **Test disaster recovery** - Ensure cost monitoring fails gracefully if bridge unavailable

---

## Support & Troubleshooting

### Validate Cost Monitoring is Working

```bash
# Check Lease Monitoring schedule
aws scheduler get-schedule \
  --name InnovationSandbox-Compute-LeaseMonitoringScheduled-* \
  --region us-gov-east-1

# Manually trigger cost monitoring
aws lambda invoke \
  --function-name ISB-LeaseMonitoring-myisb \
  --region us-gov-east-1 \
  --payload "{}" \
  response.json

# Check for commercial bridge calls in logs
aws logs filter-log-events \
  --log-group-name InnovationSandbox-Compute-ISBLogGroupE607F9A7-* \
  --region us-gov-east-1 \
  --filter-pattern "CommercialBridgeCostService" \
  --max-items 10
```

### Verify Commercial Account Mappings

```bash
# Scan all accounts with mappings
aws dynamodb scan \
  --table-name <SandboxAccountTableName> \
  --region us-gov-east-1 \
  --filter-expression "attribute_exists(commercialLinkedAccountId)" \
  --projection-expression "awsAccountId,commercialLinkedAccountId"
```

---

## Acknowledgments

This implementation enables Innovation Sandbox to operate in AWS GovCloud (US) regions while maintaining full backwards compatibility with commercial AWS deployments. The commercial bridge pattern provides a secure, scalable solution for bridging the partition boundary for cost tracking.

**Date Implemented:** October 2025
**GovCloud Regions Supported:** us-gov-east-1, us-gov-west-1
**Commercial Region:** us-east-1
