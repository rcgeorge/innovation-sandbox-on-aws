# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Generate client certificate for IAM Roles Anywhere authentication (Windows)
# Client certificates are signed by the CA and used to authenticate from external systems

param(
    [string]$ClientName = "govcloud-commercial-bridge"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CertsDir = Join-Path $ScriptDir "..\certs"

# Validate client name
if ($ClientName -notmatch '^[a-zA-Z0-9-]+$') {
    Write-Host "❌ Invalid client name. Use only alphanumeric characters and hyphens." -ForegroundColor Red
    exit 1
}

# Check if CA exists
$CaPem = Join-Path $CertsDir "ca.pem"
$CaKey = Join-Path $CertsDir "ca.key"

if (!(Test-Path $CaPem) -or !(Test-Path $CaKey)) {
    Write-Host "❌ CA certificate not found. Run 'npm run roles-anywhere:generate-ca' first." -ForegroundColor Red
    exit 1
}

# Check if client cert already exists
$ClientPem = Join-Path $CertsDir "$ClientName.pem"
$ClientKey = Join-Path $CertsDir "$ClientName.key"

if (Test-Path $ClientPem) {
    Write-Host "❌ Client certificate already exists: $ClientPem" -ForegroundColor Red
    Write-Host "   To regenerate, delete the existing files first:" -ForegroundColor Yellow
    Write-Host "   Remove-Item `"$CertsDir\$ClientName.*`"" -ForegroundColor Yellow
    exit 1
}

Write-Host "🔐 Generating client certificate for: $ClientName" -ForegroundColor Cyan

# Generate client private key (RSA 4096 for compatibility)
Write-Host "📝 Generating client private key..." -ForegroundColor White
openssl genrsa -out $ClientKey 4096

# Create OpenSSL config for client cert
$ClientConfig = Join-Path $CertsDir "$ClientName.cnf"
@"
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C = US
O = InnovationSandbox
CN = $ClientName

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = clientAuth
"@ | Out-File -FilePath $ClientConfig -Encoding ASCII

# Generate CSR
$ClientCsr = Join-Path $CertsDir "$ClientName.csr"
Write-Host "📝 Generating certificate signing request..." -ForegroundColor White
openssl req -new `
    -key $ClientKey `
    -out $ClientCsr `
    -config $ClientConfig

# Sign with CA (1 year validity)
Write-Host "📝 Signing certificate with CA (valid for 1 year)..." -ForegroundColor White
openssl x509 -req `
    -in $ClientCsr `
    -CA $CaPem `
    -CAkey $CaKey `
    -CAcreateserial `
    -out $ClientPem `
    -days 365 `
    -sha256 `
    -extfile $ClientConfig `
    -extensions v3_req

# Clean up CSR and config
Remove-Item $ClientCsr, $ClientConfig

Write-Host ""
Write-Host "✅ Client certificate generated successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "📄 Files created:" -ForegroundColor Cyan
Write-Host "   Certificate: $ClientPem" -ForegroundColor White
Write-Host "   Private Key: $ClientKey (keep secure!)" -ForegroundColor Yellow
Write-Host ""
Write-Host "🔍 Certificate details:" -ForegroundColor Cyan
openssl x509 -in $ClientPem -noout -subject -issuer -dates
Write-Host ""
Write-Host "📋 Next steps:" -ForegroundColor Cyan
Write-Host ""
Write-Host "1️⃣  Store certificate in GovCloud Secrets Manager:" -ForegroundColor White

# Read and base64 encode files
$certBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($ClientPem))
$keyBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($ClientKey))
$secretJson = "{`"cert`":`"$certBase64`",`"key`":`"$keyBase64`"}"

Write-Host "    aws secretsmanager create-secret \" -ForegroundColor Gray
Write-Host "      --name /InnovationSandbox/CommercialBridge/ClientCert \" -ForegroundColor Gray
Write-Host "      --secret-string '$secretJson' \" -ForegroundColor Gray
Write-Host "      --region us-gov-east-1" -ForegroundColor Gray
Write-Host ""
Write-Host "2️⃣  Get ARNs from RolesAnywhere stack outputs:" -ForegroundColor White
Write-Host "    cd commercial-bridge/infrastructure" -ForegroundColor Gray
Write-Host "    npx cdk deploy RolesAnywhereStack --outputs-file outputs.json" -ForegroundColor Gray
Write-Host ""
Write-Host "3️⃣  Update GovCloud Lambda environment variables with:" -ForegroundColor White
Write-Host "    - COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN" -ForegroundColor Gray
Write-Host "    - COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN" -ForegroundColor Gray
Write-Host "    - COMMERCIAL_BRIDGE_PROFILE_ARN" -ForegroundColor Gray
Write-Host "    - COMMERCIAL_BRIDGE_ROLE_ARN" -ForegroundColor Gray
Write-Host ""
Write-Host "⏰ Certificate expires in 1 year - set a reminder to rotate!" -ForegroundColor Yellow
Write-Host ""
