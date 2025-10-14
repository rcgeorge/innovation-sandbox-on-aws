#!/bin/sh
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# This script runs at container startup and substitutes environment variables into NGINX config
# VITE_API_URL is passed from ECS task definition as an environment variable

set -e

echo "Starting Innovation Sandbox Frontend..."

# Parse API_URL from VITE_API_URL environment variable
# VITE_API_URL format: https://xxxxx.execute-api.us-gov-east-1.amazonaws.com/prod/
export API_URL="${VITE_API_URL:-https://placeholder.execute-api.us-gov-east-1.amazonaws.com/prod/}"
# Extract host from URL (remove https:// and trailing /)
export API_HOST=$(echo "$API_URL" | sed -e 's|https://||' -e 's|/prod/||')

echo "Configuring NGINX with API URL: $API_URL"
echo "API Host: $API_HOST"

# Substitute environment variables in NGINX config
envsubst '${API_URL} ${API_HOST}' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

echo "NGINX configuration:"
cat /etc/nginx/conf.d/default.conf

# Start NGINX
echo "Starting NGINX..."
exec nginx -g 'daemon off;'
