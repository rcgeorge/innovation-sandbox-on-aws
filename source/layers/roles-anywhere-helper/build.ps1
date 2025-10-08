# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Download AWS IAM Roles Anywhere credential helper for Lambda layer (Windows)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinDir = Join-Path $ScriptDir "bin"
$Version = "1.0.5"
$Arch = "linux-amd64"

# Create bin directory
if (!(Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir | Out-Null
}

# Download credential helper
$HelperPath = Join-Path $BinDir "aws_signing_helper"
$Url = "https://rolesanywhere.amazonaws.com/releases/$Version/aws_signing_helper-$Arch"

Write-Host "📥 Downloading AWS IAM Roles Anywhere credential helper v$Version..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $Url -OutFile $HelperPath

Write-Host ""
Write-Host "✅ IAM Roles Anywhere credential helper layer ready!" -ForegroundColor Green
Write-Host "   Location: $HelperPath" -ForegroundColor White
Write-Host ""
