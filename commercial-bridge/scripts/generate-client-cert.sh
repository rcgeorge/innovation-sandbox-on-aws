#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Generate client certificate for IAM Roles Anywhere authentication
# Client certificates are signed by the CA and used to authenticate from external systems

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS_DIR="$SCRIPT_DIR/../certs"

# Default client name
CLIENT_NAME="${1:-govcloud-commercial-bridge}"

# Validate client name
if [[ ! "$CLIENT_NAME" =~ ^[a-zA-Z0-9-]+$ ]]; then
  echo "❌ Invalid client name. Use only alphanumeric characters and hyphens."
  exit 1
fi

# Check if CA exists
if [ ! -f "$CERTS_DIR/ca.pem" ] || [ ! -f "$CERTS_DIR/ca.key" ]; then
  echo "❌ CA certificate not found. Run 'npm run roles-anywhere:generate-ca' first."
  exit 1
fi

# Check if client cert already exists
if [ -f "$CERTS_DIR/$CLIENT_NAME.pem" ]; then
  echo "❌ Client certificate already exists: $CERTS_DIR/$CLIENT_NAME.pem"
  echo "   To regenerate, delete the existing files first:"
  echo "   rm $CERTS_DIR/$CLIENT_NAME.*"
  exit 1
fi

echo "🔐 Generating client certificate for: $CLIENT_NAME"

# Generate client private key (RSA 4096 for compatibility)
echo "📝 Generating client private key..."
openssl genrsa -out "$CERTS_DIR/$CLIENT_NAME.key" 4096

# Create OpenSSL config for client cert
cat > "$CERTS_DIR/$CLIENT_NAME.cnf" << EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C = US
O = InnovationSandbox
CN = $CLIENT_NAME

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = clientAuth
EOF

# Generate CSR
echo "📝 Generating certificate signing request..."
openssl req -new \
  -key "$CERTS_DIR/$CLIENT_NAME.key" \
  -out "$CERTS_DIR/$CLIENT_NAME.csr" \
  -config "$CERTS_DIR/$CLIENT_NAME.cnf"

# Sign with CA (1 year validity)
echo "📝 Signing certificate with CA (valid for 1 year)..."
openssl x509 -req \
  -in "$CERTS_DIR/$CLIENT_NAME.csr" \
  -CA "$CERTS_DIR/ca.pem" \
  -CAkey "$CERTS_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERTS_DIR/$CLIENT_NAME.pem" \
  -days 365 \
  -sha256 \
  -extfile "$CERTS_DIR/$CLIENT_NAME.cnf" \
  -extensions v3_req

# Set permissions
chmod 600 "$CERTS_DIR/$CLIENT_NAME.key"
chmod 644 "$CERTS_DIR/$CLIENT_NAME.pem"

# Clean up CSR and config
rm "$CERTS_DIR/$CLIENT_NAME.csr" "$CERTS_DIR/$CLIENT_NAME.cnf"

echo ""
echo "✅ Client certificate generated successfully!"
echo ""
echo "📄 Files created:"
echo "   Certificate: $CERTS_DIR/$CLIENT_NAME.pem"
echo "   Private Key: $CERTS_DIR/$CLIENT_NAME.key (keep secure!)"
echo ""
echo "🔍 Certificate details:"
openssl x509 -in "$CERTS_DIR/$CLIENT_NAME.pem" -noout -subject -issuer -dates
echo ""
echo "📋 Next steps:"
echo ""
echo "1️⃣  Store certificate in GovCloud Secrets Manager:"
echo "    aws secretsmanager create-secret \\"
echo "      --name /InnovationSandbox/CommercialBridge/ClientCert \\"
echo "      --secret-string \"{\\\"cert\\\":\\\"\$(base64 -w0 $CERTS_DIR/$CLIENT_NAME.pem)\\\",\\\"key\\\":\\\"\$(base64 -w0 $CERTS_DIR/$CLIENT_NAME.key)\\\"}\" \\"
echo "      --region us-gov-east-1"
echo ""
echo "2️⃣  Get ARNs from RolesAnywhere stack outputs:"
echo "    cd commercial-bridge/infrastructure"
echo "    npx cdk deploy RolesAnywhereStack --outputs-file outputs.json"
echo ""
echo "3️⃣  Update GovCloud Lambda environment variables with:"
echo "    - COMMERCIAL_BRIDGE_CLIENT_CERT_SECRET_ARN"
echo "    - COMMERCIAL_BRIDGE_TRUST_ANCHOR_ARN"
echo "    - COMMERCIAL_BRIDGE_PROFILE_ARN"
echo "    - COMMERCIAL_BRIDGE_ROLE_ARN"
echo ""
echo "⏰ Certificate expires in 1 year - set a reminder to rotate!"
echo ""
