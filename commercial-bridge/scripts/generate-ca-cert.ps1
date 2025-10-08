# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Generate self-signed CA certificate for IAM Roles Anywhere (Windows)
# This script creates the root CA certificate and private key

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CertsDir = Join-Path $ScriptDir "..\certs"

# Create certs directory if it doesn't exist
if (!(Test-Path $CertsDir)) {
    New-Item -ItemType Directory -Path $CertsDir | Out-Null
}

# Check if CA already exists
$CaPem = Join-Path $CertsDir "ca.pem"
$CaKey = Join-Path $CertsDir "ca.key"

if ((Test-Path $CaPem) -and (Test-Path $CaKey)) {
    Write-Host "❌ CA certificate already exists at $CaPem" -ForegroundColor Red
    Write-Host "   To regenerate, delete the existing files first:" -ForegroundColor Yellow
    Write-Host "   Remove-Item $CaPem, $CaKey" -ForegroundColor Yellow
    exit 1
}

Write-Host "🔐 Generating self-signed CA certificate for IAM Roles Anywhere..." -ForegroundColor Cyan

# Generate CA private key using elliptic curve
Write-Host "📝 Generating CA private key..." -ForegroundColor White
openssl ecparam -genkey -name secp384r1 -out $CaKey

# Create OpenSSL config for CA
$CaConfig = Join-Path $CertsDir "ca.cnf"
@"
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_ca
prompt = no

[req_distinguished_name]
C = US
O = InnovationSandbox
CN = ISB-CommercialBridge-CA

[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, cRLSign, keyCertSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always, issuer:always
"@ | Out-File -FilePath $CaConfig -Encoding ASCII

# Generate self-signed CA certificate (10 years)
Write-Host "📝 Generating self-signed CA certificate (valid for 10 years)..." -ForegroundColor White
openssl req -new -x509 `
    -key $CaKey `
    -out $CaPem `
    -days 3650 `
    -sha256 `
    -config $CaConfig `
    -extensions v3_ca

Write-Host ""
Write-Host "✅ CA certificate generated successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "📄 Files created:" -ForegroundColor Cyan
Write-Host "   CA Certificate: $CaPem" -ForegroundColor White
Write-Host "   CA Private Key: $CaKey (keep secure!)" -ForegroundColor Yellow
Write-Host ""
Write-Host "🔍 Certificate details:" -ForegroundColor Cyan
openssl x509 -in $CaPem -noout -subject -issuer -dates
Write-Host ""
Write-Host "⚠️  IMPORTANT SECURITY NOTES:" -ForegroundColor Yellow
Write-Host "   1. Keep ca.key HIGHLY SECURE - anyone with this key can issue trusted certificates" -ForegroundColor White
Write-Host "   2. Consider storing ca.key in AWS Secrets Manager for backup" -ForegroundColor White
Write-Host "   3. Do NOT commit ca.key to version control (already in .gitignore)" -ForegroundColor White
Write-Host "   4. ca.pem is safe to share - it will be uploaded to IAM Roles Anywhere" -ForegroundColor White
Write-Host ""
Write-Host "📋 Next steps:" -ForegroundColor Cyan
Write-Host "   1. Deploy the RolesAnywhere stack with this CA certificate" -ForegroundColor White
Write-Host "   2. Generate client certificates: npm run roles-anywhere:generate-client-cert" -ForegroundColor White
Write-Host "   3. Store client certificates in GovCloud Secrets Manager" -ForegroundColor White
Write-Host ""
