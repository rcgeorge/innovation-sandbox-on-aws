# Post-Deployment Stack

The Post-Deployment stack automates the manual configuration steps from the Innovation Sandbox on AWS Implementation Guide that must be completed after the initial stack deployment.

## Overview

This stack creates a custom resource Lambda function that:

1. **Creates IAM Identity Center SAML 2.0 Application** - Automatically sets up the SAML application with the correct ACS URL and audience
2. **Assigns Groups to Application** - Assigns the three IAM Identity Center groups (Admins, Managers, Users) to the SAML application
3. **Updates AWS AppConfig** - Configures the GlobalConfig with:
   - IdP Sign-In URL
   - IdP Sign-Out URL
   - IdP Audience
   - Web Application URL
   - AWS Access Portal URL
4. **Stores Certificate in Secrets Manager** - Saves the IAM Identity Center SAML certificate for authentication

## Prerequisites

Before deploying this stack, you must:

1. Deploy all other stacks in order:
   - Account Pool Stack
   - IDC Stack
   - Data Stack
   - Compute Stack (or Container Stack for GovCloud)

2. Obtain the web application URL from stack outputs:
   - **Commercial AWS**: CloudFront URL from Compute stack outputs (`CloudFrontDistributionUrl`)
   - **GovCloud**: ALB URL from Container stack outputs (`FrontendUrl`)

3. Set the `WEB_APP_URL` environment variable in your `.env` file:
   ```shell
   WEB_APP_URL=https://your-cloudfront-url.cloudfront.net
   # OR for GovCloud
   WEB_APP_URL=https://your-alb-url.us-gov-west-1.elb.amazonaws.com
   ```

## Deployment

Deploy the post-deployment stack after all other stacks:

```shell
npm run deploy:post-deployment
```

This will:
- Read configuration from existing stacks via SSM parameters
- Create the IAM Identity Center SAML application
- Configure authentication settings in AppConfig
- Store the SAML certificate in Secrets Manager

## Manual Steps Still Required

After deploying this stack, you still need to manually:

### 1. Configure Attribute Mappings in IAM Identity Center

The SAML attribute mappings must be configured in the IAM Identity Center console:

1. Navigate to the IAM Identity Center console
2. Go to **Applications** → **Customer managed**
3. Select the created application (e.g., `InnovationSandboxApp-myisb`)
4. Click **Actions** → **Edit attribute mappings**
5. Configure the **Subject** attribute:
   - **Maps to this string value or user attribute in IAM Identity Center**: `${user:email}`
   - **Format**: `emailAddress`
6. Click **Save changes**

### 2. Add Users to IAM Identity Center Groups

Assign users to the appropriate groups for access control:

1. Navigate to the IAM Identity Center console
2. Go to **Users** or **Groups**
3. Add users to one or more of these groups:
   - `<NAMESPACE>_IsbUsersGroup` - Read-only access to sandbox accounts
   - `<NAMESPACE>_IsbManagersGroup` - Can manage leases and templates
   - `<NAMESPACE>_IsbAdminsGroup` - Full administrative access

### 3. Verify SAML Configuration

Verify the SAML application is properly configured:

1. Check that the Application ACS URL is correct:
   ```
   <WEB_APP_URL>/api/auth/login/callback
   ```

2. Check that the Application SAML audience is correct:
   ```
   Isb-<NAMESPACE>-Audience
   ```

3. Test authentication by logging into the web application

## Stack Outputs

After deployment, the stack provides these outputs:

- **ApplicationArn** - ARN of the created IAM Identity Center application
- **IdpSignInUrl** - IAM Identity Center sign-in URL
- **IdpSignOutUrl** - IAM Identity Center sign-out URL
- **PostDeploymentStatus** - Status message indicating completion

## Troubleshooting

### Application Creation Fails

If the SAML application creation fails:
- Ensure the SSO Instance ARN is correct in your `.env` file
- Verify you have permissions to create applications in IAM Identity Center
- Check that no application with the same name already exists

### AppConfig Update Fails

If AppConfig update fails:
- Verify the Data stack deployed successfully
- Check that AppConfig resources exist in the Data stack
- Ensure Lambda has permissions to update AppConfig

### Secrets Manager Update Fails

If certificate storage fails:
- Verify Lambda has permissions to create/update secrets
- Check that the secret name doesn't conflict with existing secrets
- Review CloudWatch logs for the Lambda function

## Cleanup

To remove the post-deployment stack:

```shell
npm run destroy:post-deployment
```

This will:
- Delete the IAM Identity Center SAML application
- Retain the AppConfig configuration (will need manual cleanup if desired)
- Retain the Secrets Manager secret (will need manual cleanup if desired)

## Architecture

```
┌─────────────────────────────────────────────────┐
│         Post-Deployment Stack                    │
│                                                  │
│  ┌────────────────────────────────────────┐    │
│  │  Custom Resource Lambda                 │    │
│  │                                         │    │
│  │  ┌──────────────────────────────────┐  │    │
│  │  │  IAM Identity Center             │  │    │
│  │  │  - Create SAML App               │  │    │
│  │  │  - Assign Groups                 │  │    │
│  │  │  - Get Metadata                  │  │    │
│  │  └──────────────────────────────────┘  │    │
│  │                                         │    │
│  │  ┌──────────────────────────────────┐  │    │
│  │  │  AWS AppConfig                   │  │    │
│  │  │  - Update GlobalConfig           │  │    │
│  │  │  - Set Auth URLs                 │  │    │
│  │  └──────────────────────────────────┘  │    │
│  │                                         │    │
│  │  ┌──────────────────────────────────┐  │    │
│  │  │  AWS Secrets Manager             │  │    │
│  │  │  - Store IDC Certificate         │  │    │
│  │  └──────────────────────────────────┘  │    │
│  └────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

## IAM Permissions Required

The custom resource Lambda function requires these permissions:

- **IAM Identity Center**:
  - `sso:CreateApplication`
  - `sso:DeleteApplication`
  - `sso:DescribeApplication`
  - `sso:UpdateApplication`
  - `sso:PutApplicationAssignmentConfiguration`
  - `sso:CreateApplicationAssignment`

- **AWS AppConfig**:
  - `appconfig:GetLatestConfiguration`
  - `appconfig:StartConfigurationSession`
  - `appconfig:CreateHostedConfigurationVersion`

- **AWS Secrets Manager**:
  - `secretsmanager:CreateSecret`
  - `secretsmanager:UpdateSecret`
  - `secretsmanager:DescribeSecret`
  - `secretsmanager:PutSecretValue`

## Notes

- This stack must be deployed to the same account as the Data and Compute stacks (Hub account)
- The stack uses SSM parameters to retrieve configuration from other stacks
- SAML application creation may take a few minutes to complete
- The Lambda function has a 5-minute timeout to accommodate API rate limits
