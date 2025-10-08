#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Generate self-signed CA certificate for IAM Roles Anywhere
# This script creates the root CA certificate and private key

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS_DIR="$SCRIPT_DIR/../certs"

# Create certs directory if it doesn't exist
mkdir -p "$CERTS_DIR"

# Check if CA already exists
if [ -f "$CERTS_DIR/ca.pem" ] && [ -f "$CERTS_DIR/ca.key" ]; then
  echo "❌ CA certificate already exists at $CERTS_DIR/ca.pem"
  echo "   To regenerate, delete the existing files first:"
  echo "   rm $CERTS_DIR/ca.pem $CERTS_DIR/ca.key"
  exit 1
fi

echo "🔐 Generating self-signed CA certificate for IAM Roles Anywhere..."

# Generate CA private key using elliptic curve (more secure, smaller key size)
echo "📝 Generating CA private key..."
openssl ecparam -genkey -name secp384r1 -out "$CERTS_DIR/ca.key"

# Create OpenSSL config for CA
cat > "$CERTS_DIR/ca.cnf" << 'EOF'
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
EOF

# Generate self-signed CA certificate (10 years)
echo "📝 Generating self-signed CA certificate (valid for 10 years)..."
openssl req -new -x509 \
  -key "$CERTS_DIR/ca.key" \
  -out "$CERTS_DIR/ca.pem" \
  -days 3650 \
  -sha256 \
  -config "$CERTS_DIR/ca.cnf" \
  -extensions v3_ca

# Set restrictive permissions on private key
chmod 600 "$CERTS_DIR/ca.key"
chmod 644 "$CERTS_DIR/ca.pem"

echo ""
echo "✅ CA certificate generated successfully!"
echo ""
echo "📄 Files created:"
echo "   CA Certificate: $CERTS_DIR/ca.pem"
echo "   CA Private Key: $CERTS_DIR/ca.key (keep secure!)"
echo ""
echo "🔍 Certificate details:"
openssl x509 -in "$CERTS_DIR/ca.pem" -noout -subject -issuer -dates
echo ""
echo "⚠️  IMPORTANT SECURITY NOTES:"
echo "   1. Keep ca.key HIGHLY SECURE - anyone with this key can issue trusted certificates"
echo "   2. Consider storing ca.key in AWS Secrets Manager for backup"
echo "   3. Do NOT commit ca.key to version control (already in .gitignore)"
echo "   4. ca.pem is safe to share - it will be uploaded to IAM Roles Anywhere"
echo ""
echo "📋 Next steps:"
echo "   1. Deploy the RolesAnywhere stack with this CA certificate"
echo "   2. Generate client certificates: npm run roles-anywhere:generate-client-cert"
echo "   3. Store client certificates in GovCloud Secrets Manager"
echo ""
