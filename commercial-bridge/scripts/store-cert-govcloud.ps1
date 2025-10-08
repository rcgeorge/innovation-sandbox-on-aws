# Store client certificate in GovCloud Secrets Manager
$ErrorActionPreference = "Stop"

$certPath = "$PSScriptRoot\..\certs\govcloud-commercial-bridge.pem"
$keyPath = "$PSScriptRoot\..\certs\govcloud-commercial-bridge.key"

# Read and base64 encode
$certBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($certPath))
$keyBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($keyPath))

# Create properly formatted JSON string (NOT PowerShell object)
$secret = "{`"cert`":`"$certBase64`",`"key`":`"$keyBase64`"}"

Write-Host "Creating secret in GovCloud Secrets Manager..." -ForegroundColor Cyan

# Store in GovCloud
aws secretsmanager create-secret `
    --name /InnovationSandbox/CommercialBridge/ClientCert `
    --secret-string $secret `
    --region us-gov-east-1

Write-Host ""
Write-Host "✅ Certificate stored successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Getting secret ARN..." -ForegroundColor Cyan

# Get ARN
$arn = aws secretsmanager describe-secret `
    --secret-id /InnovationSandbox/CommercialBridge/ClientCert `
    --region us-gov-east-1 `
    --query 'ARN' `
    --output text

Write-Host "Secret ARN: $arn" -ForegroundColor White
Write-Host ""
Write-Host "Add this to your .env file:" -ForegroundColor Yellow
Write-Host "COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN=$arn" -ForegroundColor White
