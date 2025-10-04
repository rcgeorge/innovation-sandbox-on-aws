# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Innovation Sandbox Frontend - NGINX Container
# This Dockerfile expects the frontend to be pre-built (dist/ folder exists)
# Run `npm run build` from the frontend workspace before building this image

FROM public.ecr.aws/nginx/nginx:alpine-slim

# Copy pre-built assets to NGINX serving directory
COPY dist /usr/share/nginx/html

# Copy custom NGINX configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:80/ || exit 1

# Start NGINX
CMD ["nginx", "-g", "daemon off;"]
