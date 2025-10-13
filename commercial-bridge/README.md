# Commercial Bridge API

This CDK application deploys an API Gateway with Lambda functions to the commercial AWS account, enabling the GovCloud Innovation Sandbox to:
1. Query cost information for GovCloud accounts via AWS Cost Explorer
2. Create new GovCloud accounts via AWS Organizations CreateGovCloudAccount API

## Architecture

- **API Gateway**: REST API with API Key authentication
- **Lambda Functions**:
  - `cost-information`: Queries Cost Explorer for linked account costs
  - `create-govcloud-account`: Creates GovCloud accounts and polls for completion status
- **IAM Roles**: Permissions for Cost Explorer and Organizations APIs
- **CloudWatch**: Logging for API Gateway and Lambda functions

## Prerequisites

1. **AWS Organization with GovCloud**: Your commercial account must be part of an AWS Organization that has GovCloud enabled
2. **AWS CLI Profile**: Configure a profile named `commercial` for your commercial account
   ```bash
   aws configure --profile commercial
   ```
3. **Node.js**: Version 18 or higher
4. **AWS CDK**: Version 2.172.0 or higher

## Deployment Steps

### 1. Install Dependencies

```bash
cd commercial-bridge
npm install
```

### 2. Bootstrap CDK in Commercial Account

Bootstrap CDK in the commercial account (only needed once per account/region):

**Windows:**
```cmd
bootstrap-commercial.bat
```

**Linux/Mac:**
```bash
cd infrastructure
AWS_PROFILE=commercial npx cdk bootstrap
```

### 3. Build and Deploy

**Windows:**
```cmd
deploy-commercial.bat
```

**Linux/Mac:**
```bash
npm run build
cd infrastructure
AWS_PROFILE=commercial npm run deploy
```

The deploy command will:
- Build all Lambda TypeScript code
- Synthesize CloudFormation templates
- Deploy core stacks:
  1. `CommercialBridge-CostInfo`
  2. `CommercialBridge-AccountCreation`
  3. `CommercialBridge-AcceptInvitation`
  4. `CommercialBridge-ApiGateway`
- Deploy optional stacks (if configured):
  5. `CommercialBridge-PCA` (if ENABLE_PCA=true, ~$400/month)
  6. `CommercialBridge-RolesAnywhere` (if ENABLE_ROLES_ANYWHERE=true)

**Note**: You'll be prompted to approve IAM role creation. Review and approve the changes.

### 4. Retrieve API Key

After deployment, retrieve the API key value:

```bash
# Get the API key ID from CloudFormation outputs
aws cloudformation describe-stacks \
  --stack-name CommercialBridge-ApiGateway \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiKeyId`].OutputValue' \
  --output text \
  --profile commercial

# Use the key ID to get the actual API key value
aws apigateway get-api-key \
  --api-key <API_KEY_ID_FROM_ABOVE> \
  --include-value \
  --query 'value' \
  --output text \
  --profile commercial
```

### 5. Store API Credentials in GovCloud Secrets Manager

Store the API URL and API key in AWS Secrets Manager in your GovCloud account:

```bash
# Get the API URL from CloudFormation outputs
aws cloudformation describe-stacks \
  --stack-name CommercialBridge-ApiGateway \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' \
  --output text \
  --profile commercial

# Store in GovCloud Secrets Manager
aws secretsmanager create-secret \
  --name /InnovationSandbox/CommercialBridge/ApiCredentials \
  --description "API credentials for commercial bridge API" \
  --secret-string "{\"apiUrl\":\"<API_URL>\",\"apiKey\":\"<API_KEY>\"}" \
  --region us-gov-east-1  # or your GovCloud region
```

## API Endpoints

### 1. Get Cost Information

**Endpoint**: `GET /cost-info`

**Query Parameters**:
- `linkedAccountId` (required): GovCloud account ID
- `startDate` (required): Start date in `YYYY-MM-DD` format
- `endDate` (required): End date in `YYYY-MM-DD` format
- `granularity` (optional): `DAILY` or `MONTHLY` (default: `DAILY`)

**Headers**:
- `x-api-key`: Your API key

**Example Request**:
```bash
curl -X GET \
  "https://<API_ID>.execute-api.us-east-1.amazonaws.com/prod/cost-info?linkedAccountId=123456789012&startDate=2025-09-01&endDate=2025-09-30" \
  -H "x-api-key: <YOUR_API_KEY>"
```

**Example Response**:
```json
{
  "linkedAccountId": "123456789012",
  "startDate": "2025-09-01",
  "endDate": "2025-09-30",
  "totalCost": 1234.56,
  "currency": "USD",
  "breakdown": [
    {
      "service": "Amazon Elastic Compute Cloud",
      "cost": 567.89
    },
    {
      "service": "Amazon Simple Storage Service",
      "cost": 234.56
    }
  ]
}
```

### 2. Create GovCloud Account

**Endpoint**: `POST /govcloud-accounts`

**Headers**:
- `x-api-key`: Your API key
- `Content-Type`: `application/json`

**Request Body**:
```json
{
  "email": "account-email@example.com",
  "accountName": "My GovCloud Sandbox Account",
  "roleName": "OrganizationAccountAccessRole",
  "iamUserAccessToBilling": "DENY"
}
```

**Example Request**:
```bash
curl -X POST \
  "https://<API_ID>.execute-api.us-east-1.amazonaws.com/prod/govcloud-accounts" \
  -H "x-api-key: <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "sandbox-account@example.com",
    "accountName": "Innovation Sandbox Account 1"
  }'
```

**Example Response (In Progress)**:
```json
{
  "requestId": "car-abc123def456",
  "status": "IN_PROGRESS",
  "createTime": "2025-10-06T14:30:00.000Z",
  "message": "Account creation is still in progress. Check status using the requestId."
}
```

**Example Response (Succeeded)**:
```json
{
  "requestId": "car-abc123def456",
  "status": "SUCCEEDED",
  "govCloudAccountId": "123456789012",
  "commercialAccountId": "987654321098",
  "createTime": "2025-10-06T14:35:00.000Z"
}
```

### 3. Check Account Creation Status

**Endpoint**: `GET /govcloud-accounts/{requestId}`

**Headers**:
- `x-api-key`: Your API key

**Example Request**:
```bash
curl -X GET \
  "https://<API_ID>.execute-api.us-east-1.amazonaws.com/prod/govcloud-accounts/car-abc123def456" \
  -H "x-api-key: <YOUR_API_KEY>"
```

**Response**: Same format as the POST response above

## Usage Limits

The API has the following usage limits configured:

- **Rate Limit**: 100 requests per second
- **Burst Limit**: 200 requests
- **Quota**: 10,000 requests per month

These limits can be adjusted in `infrastructure/lib/api-gateway-stack.ts`.

## Monitoring

### CloudWatch Logs

- API Gateway logs: `/aws/apigateway/CommercialBridgeApi`
- Cost Info Lambda logs: `/aws/lambda/CostInfoFunction`
- Create GovCloud Account Lambda logs: `/aws/lambda/CreateGovCloudAccountFunction`
- Accept Invitation Lambda logs: `/aws/lambda/AcceptInvitationFunction`

### CloudWatch Metrics

API Gateway and Lambda metrics are automatically enabled. Key metrics:

- `4XXError` / `5XXError`: API Gateway error rates
- `Count`: Number of API requests
- `Latency`: API response time
- `Errors` / `Throttles`: Lambda function errors and throttles

## Cleanup

To remove all resources:

```bash
npm run cdk:destroy
```

This will delete all deployed stacks in reverse dependency order. From the repository root, you can also use:

```bash
npm run commercial:destroy
```

## Troubleshooting

### "User is not authorized to perform: organizations:CreateGovCloudAccount"

Ensure the commercial account is the **management account** of the AWS Organization, or has been delegated the Organizations permissions. Only the management account can create GovCloud accounts.

### "Cost data not found for linked account"

Verify:
1. The GovCloud account ID is correct
2. The date range has cost data (accounts may have zero costs)
3. Cost Explorer has been enabled (it can take 24 hours to populate)

### API Key not working

Ensure you're passing the API key in the `x-api-key` header (lowercase), not `X-Api-Key` or other variations.

## Cost Estimate

Estimated monthly costs (assuming moderate usage):

- API Gateway: $3.50 per million requests + $0.09 per GB data transfer
- Lambda: $0.20 per million requests + compute time
- CloudWatch Logs: $0.50 per GB ingested
- **Total**: ~$10-20/month for typical Innovation Sandbox usage

## Security Considerations

1. **API Key Security**: Store API keys securely in AWS Secrets Manager
2. **IAM Permissions**: Lambda functions have minimal required permissions (Cost Explorer read-only, Organizations create/describe only)
3. **Network Security**: Consider using API Gateway resource policies to restrict access by source IP if known
4. **Audit Logging**: CloudWatch logs capture all API calls for audit purposes

## Future Enhancements

Potential improvements for future iterations:

1. **Budget Alerts**: Add CloudWatch alarms for cost thresholds
2. **Account Tagging**: Automatically tag created accounts with metadata
3. **Async Processing**: Use Step Functions for long-running account creation
4. **Caching**: Add API Gateway caching for cost queries
5. **Custom Domain**: Set up Route 53 and API Gateway custom domain
