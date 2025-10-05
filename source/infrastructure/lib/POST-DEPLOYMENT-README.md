# Post-Deployment Manual Configuration Guide

## Overview

The Post-Deployment stack automates updating AWS AppConfig with your web application URL. However, **SAML application creation must be done manually** through the AWS IAM Identity Center console due to AWS API limitations.

## Important Limitation

**AWS IAM Identity Center does not support creating SAML 2.0 applications via API.** The `CreateApplication` API only supports OAuth 2.0 applications. Therefore, the SAML application setup must be completed manually through the AWS Management Console.

Source: [AWS IAM Identity Center CreateApplication API Documentation](https://docs.aws.amazon.com/singlesignon/latest/APIReference/API_CreateApplication.html)

> "This API does not support creating SAML 2.0 customer managed applications or AWS managed applications. You can create a SAML 2.0 customer managed application in the AWS Management Console only."

## Prerequisites

Before starting manual configuration:

1. ✅ All other stacks deployed successfully (Account Pool, IDC, Data, Compute/Container)
2. ✅ Post-Deployment stack deployed successfully
3. ✅ You have the following values from stack outputs:
   - `WEB_APP_URL` - Your web application URL (CloudFront or ALB)
   - `AWS_ACCESS_PORTAL_URL` - Your IAM Identity Center login page
   - Your namespace value (e.g., "myisb")

## Manual SAML Application Setup

### Step 1: Navigate to IAM Identity Center Console

1. Sign in to the AWS Management Console
2. Navigate to **IAM Identity Center**
3. In the left navigation, click **Applications**

### Step 2: Create Custom SAML 2.0 Application

1. Click **Add application**
2. Select **Add custom SAML 2.0 application**
3. Click **Next**

### Step 3: Configure Application Details

**Display name:**
```
InnovationSandboxApp-{namespace}
```
Replace `{namespace}` with your namespace (e.g., `InnovationSandboxApp-myisb`)

**Description:**
```
Innovation Sandbox on AWS SAML Application
```

**Application start URL:** (Optional)
```
{WEB_APP_URL}
```

**Application ACS URL:**
```
{WEB_APP_URL}/api/auth/login/callback
```

**Application SAML audience:**
```
Isb-{namespace}-Audience
```
Replace `{namespace}` with your namespace (e.g., `Isb-myisb-Audience`)

Click **Submit**

### Step 4: Configure Attribute Mappings

After creating the application, you need to configure attribute mappings:

1. In the application details page, go to the **Attribute mappings** tab
2. Click **Add new attribute mapping**
3. Add the following mapping:

| User attribute in the application | Maps to this string value or user attribute in IAM Identity Center | Format |
|-----------------------------------|-------------------------------------------------------------------|--------|
| `Subject` | `${user:email}` | emailAddress |
| `email` | `${user:email}` | unspecified |

4. Click **Save changes**

### Step 5: Assign Users and Groups

1. In the application details page, go to the **Assigned users** tab
2. Click **Assign users**
3. Assign the three IAM Identity Center groups:
   - `IsbAdminsGroup-{namespace}` (or your custom admin group name)
   - `IsbManagersGroup-{namespace}` (or your custom manager group name)
   - `IsbUsersGroup-{namespace}` (or your custom user group name)
4. Click **Assign users**

### Step 6: Download IAM Identity Center Metadata

1. In the application details page, go to the **Configuration** tab
2. Under **IAM Identity Center metadata**, click **Download**
3. Save the metadata XML file
4. Open the XML file and locate the X.509 certificate between `<X509Certificate>` tags
5. Copy the certificate value (the long base64-encoded string)

### Step 7: Update AppConfig with SAML Details

You need to manually update the AppConfig configuration to replace placeholder values with actual SAML metadata.

#### For GovCloud:

**Sign-in URL format:**
```
https://{identity-store-id}.signin.aws-us-gov/platform/saml/{application-id}
```

**Sign-out URL format:**
```
https://{identity-store-id}.signin.aws-us-gov/platform/logout
```

#### For Commercial AWS:

**Sign-in URL format:**
```
https://{identity-store-id}.awsapps.com/start
```

**Sign-out URL format:**
```
https://{identity-store-id}.awsapps.com/start#/signout
```

You can find these URLs in the IAM Identity Center SAML application metadata XML file.

#### Update AppConfig Configuration:

1. Navigate to **AWS AppConfig** in the AWS Console
2. Find your Innovation Sandbox application
3. Open the global configuration profile
4. Edit the configuration and update the `auth` section:

```yaml
auth:
  maintenanceMode: false
  idpSignInUrl: "https://d-xxxxxxxxxx.awsapps.com/start"  # Replace with actual sign-in URL
  idpSignOutUrl: "https://d-xxxxxxxxxx.awsapps.com/start#/signout"  # Replace with actual sign-out URL
  idpAudience: "Isb-{namespace}-Audience"  # Should already be set correctly
  webAppUrl: "{WEB_APP_URL}"  # Should already be set correctly
  awsAccessPortalUrl: "{AWS_ACCESS_PORTAL_URL}"  # Should already be set correctly
  sessionDurationInMinutes: 60
```

5. Save and deploy the configuration

### Step 8: Store Certificate in Secrets Manager

1. Navigate to **AWS Secrets Manager** in the AWS Console
2. Find or create the secret: `/InnovationSandbox/{namespace}/Auth/IDPCert`
3. Update the secret value with the X.509 certificate you copied in Step 6
4. The certificate should be stored as plain text (the base64-encoded string without the `<X509Certificate>` tags)

### Step 9: Verify Configuration

1. Navigate to your web application URL
2. You should be redirected to the IAM Identity Center login page
3. Log in with a user assigned to one of the three groups
4. You should be redirected back to the Innovation Sandbox application

## Troubleshooting

### Application doesn't appear in IAM Identity Center

- Verify you selected "Add custom SAML 2.0 application" (not OAuth)
- Check that the application name matches the expected format

### Login redirect fails

- Verify the Application ACS URL matches exactly: `{WEB_APP_URL}/api/auth/login/callback`
- Check that attribute mappings are configured correctly
- Ensure users are assigned to the application groups

### Certificate errors

- Verify the certificate in Secrets Manager doesn't include the XML tags
- Ensure the certificate is base64-encoded (no line breaks or formatting)

### Configuration not updating

- Check AppConfig deployment status
- Verify the configuration profile is deployed
- May take a few minutes for changes to propagate

## GovCloud-Specific Considerations

For AWS GovCloud deployments:

1. **Application ACS URL and Audience** differ from commercial AWS:
   - ACS URL: `https://signin.amazonaws-us-gov.com/saml`
   - Audience: `urn:amazon:webservices:govcloud`

2. **Sign-in/Sign-out URLs** use the `aws-us-gov` domain:
   - Sign-in: `https://{identity-store-id}.signin.aws-us-gov/platform/saml/{application-id}`
   - Sign-out: `https://{identity-store-id}.signin.aws-us-gov/platform/logout`

## Additional Resources

- [AWS IAM Identity Center User Guide - Setting up customer managed SAML 2.0 applications](https://docs.aws.amazon.com/singlesignon/latest/userguide/customermanagedapps-saml2-setup.html)
- [Enabling SAML 2.0 federation with AWS IAM Identity Center and AWS GovCloud](https://aws.amazon.com/blogs/publicsector/enabling-saml-2-0-federation-iam-identity-center-aws-govcloud-us/)
- [AWS IAM Identity Center API Reference - CreateApplication](https://docs.aws.amazon.com/singlesignon/latest/APIReference/API_CreateApplication.html)
