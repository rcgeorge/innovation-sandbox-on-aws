# CodeBuild Container Image Build Setup

This guide explains how to use AWS CodeBuild to build container images for Innovation Sandbox without requiring Docker to be installed locally.

## Overview

The CodeBuild stack provides an alternative to local Docker builds for users who:
- Don't have Docker installed or Docker Desktop available
- Work on Windows systems where Docker is difficult to configure
- Want consistent, reproducible builds in a managed environment
- Need to build container images in CI/CD pipelines
- Prefer cloud-based builds over local builds

## Architecture

The CodeBuild stack creates two CodeBuild projects:

1. **AWS Nuke Build Project** - Builds the account cleaner container image
   - Source: `source/infrastructure/lib/components/account-cleaner/`
   - Buildspec: `source/infrastructure/lib/components/account-cleaner/buildspec.yml`
   - Target: ECR repository specified by `PRIVATE_ECR_REPO`

2. **Frontend Build Project** - Builds the web UI container image
   - Source: `source/frontend/`
   - Buildspec: `source/frontend/buildspec.yml`
   - Target: ECR repository specified by `PRIVATE_ECR_FRONTEND_REPO`

## Prerequisites

### 1. ECR Repositories

Create ECR repositories to store the container images:

```bash
# Create AWS Nuke repository
aws ecr create-repository \
  --repository-name innovation-sandbox-nuke \
  --region us-east-1

# Create Frontend repository (optional, for Container stack deployment)
aws ecr create-repository \
  --repository-name innovation-sandbox-frontend \
  --region us-east-1
```

### 2. Environment Variables

Add these variables to your `.env` file:

```bash
# Required for CodeBuild stack
PRIVATE_ECR_REPO=innovation-sandbox-nuke
PRIVATE_ECR_REPO_REGION=us-east-1
PRIVATE_ECR_FRONTEND_REPO=innovation-sandbox-frontend
```

## Deployment

### Step 1: Deploy the CodeBuild Stack

```bash
npm run deploy:codebuild
```

This creates:
- Two CodeBuild projects (nuke and frontend)
- IAM roles with ECR push permissions
- CloudWatch Log Groups for build logs

**Stack Outputs:**
- `NukeCodeBuildProjectName` - Name of the nuke build project
- `FrontendCodeBuildProjectName` - Name of the frontend build project
- `NukeCodeBuildConsoleUrl` - AWS Console URL to monitor nuke builds
- `FrontendCodeBuildConsoleUrl` - AWS Console URL to monitor frontend builds

### Step 2: Trigger Container Builds

After the stack is deployed, trigger builds using npm scripts:

```bash
# Build both containers
npm run codebuild:build-and-push

# Or build individually
npm run codebuild:nuke      # AWS Nuke container only
npm run codebuild:frontend  # Frontend container only
```

### Step 3: Monitor Build Progress

The build script outputs AWS Console URLs where you can monitor progress:

```
🚀 Starting build for AWS Nuke container...
   Project: InnovationSandbox-nuke-build
✅ Build started successfully
   Build ID: InnovationSandbox-nuke-build:abc123...
   Build Number: 1
   Status: IN_PROGRESS

📊 Monitor build progress:
   https://console.aws.amazon.com/codesuite/codebuild/projects/...
```

**Build duration:**
- AWS Nuke: ~5-7 minutes
- Frontend: ~8-10 minutes (includes npm install and build)

## Source Code Configuration

### Default: GitHub Source

By default, the CodeBuild projects are configured to pull source from GitHub:
- Repository: `aws-solutions/innovation-sandbox-on-aws`
- Branch: `main`

### Custom GitHub Repository

To use your own fork or branch, provide these parameters when deploying the stack:

```bash
# Add to .env or pass as parameters
GITHUB_OWNER=your-username
GITHUB_REPO=innovation-sandbox-on-aws
GITHUB_BRANCH=feature-branch

# Deploy with custom source
npm run with-env -- npm run --workspace @amzn/innovation-sandbox-infrastructure cdk deploy \
  -- InnovationSandbox-CodeBuild \
  --require-approval=never \
  --parameters GitHubOwner=$GITHUB_OWNER \
  --parameters GitHubRepo=$GITHUB_REPO \
  --parameters GitHubBranch=$GITHUB_BRANCH
```

### Local Source (Alternative)

If you prefer to upload source locally instead of using GitHub:

1. **Modify the CodeBuild stack** to use `NO_SOURCE`:
   ```typescript
   source: codebuild.Source.noSource()
   ```

2. **Trigger builds with source override**:
   ```bash
   aws codebuild start-build \
     --project-name InnovationSandbox-nuke-build \
     --source-location-override ./source.zip \
     --source-type-override S3
   ```

## Customizing Dockerfiles

Both Dockerfiles can be customized for your needs:

### AWS Nuke Dockerfile
Location: `source/infrastructure/lib/components/account-cleaner/Dockerfile`

**Current base image:** `public.ecr.aws/amazonlinux/amazonlinux:2023-minimal`

**Example customizations:**
```dockerfile
# Use a different base image
FROM public.ecr.aws/ubuntu/ubuntu:22.04

# Install additional tools
RUN apt-get update && apt-get install -y \
    custom-tool \
    another-dependency

# Use a specific nuke version
ARG NUKE_VERSION=3.56.1
ADD https://github.com/ekristen/aws-nuke/releases/download/v${NUKE_VERSION}/aws-nuke-v${NUKE_VERSION}-linux-amd64.tar.gz nuke-binary.tar.gz
```

### Frontend Dockerfile
Location: `source/frontend/Dockerfile`

**Current base image:** `public.ecr.aws/nginx/nginx:alpine-slim`

**Example customizations:**
```dockerfile
# Use a different NGINX image
FROM nginx:1.25-alpine

# Add custom NGINX modules
RUN apk add --no-cache nginx-mod-http-geoip2

# Copy custom configuration
COPY custom-nginx.conf /etc/nginx/nginx.conf

# Add health check endpoint
COPY healthcheck.html /usr/share/nginx/html/health
```

After modifying Dockerfiles, the changes will be automatically picked up on the next build.

## Build Monitoring and Debugging

### View Build Logs

```bash
# Via AWS CLI
aws logs tail /aws/codebuild/InnovationSandbox-nuke-build --follow

# Via AWS Console
# Use the console URLs from the build output
```

### Common Build Issues

#### 1. ECR Authentication Failure
```
Error response from daemon: Get https://<account>.dkr.ecr.<region>.amazonaws.com/v2/: no basic auth credentials
```

**Solution:** Ensure the CodeBuild project has `ecr:GetAuthorizationToken` permission (automatically granted by the stack).

#### 2. Repository Does Not Exist
```
Error response from daemon: repository <repo> not found
```

**Solution:** Create the ECR repository first:
```bash
aws ecr create-repository --repository-name innovation-sandbox-nuke
```

#### 3. Source Checkout Fails
```
DOWNLOAD_SOURCE error: Error calling GetObject: Access Denied
```

**Solution:** Verify GitHub repository is public or provide GitHub credentials if private.

## Cost Considerations

CodeBuild pricing (as of 2025):
- **Build time:** $0.005 per minute (general1.small compute)
- **Storage:** $0.10 per GB-month (build cache and logs)

**Estimated costs per build:**
- AWS Nuke build: ~$0.03 (6 minutes)
- Frontend build: ~$0.05 (10 minutes)
- Both containers: ~$0.08

**Comparison to alternatives:**
- Local Docker builds: Free (uses local compute)
- GitHub Actions: Free for public repos, $0.008/minute for private
- EC2-based builds: $0.01-0.02 per build (t3.medium spot)

**Cost optimization tips:**
- Use build caching for faster builds (enabled by default for frontend)
- Build only when necessary (not on every commit)
- Delete CodeBuild stack when not in use: `npm run destroy:codebuild`

## Cleanup

To remove the CodeBuild stack and associated resources:

```bash
npm run destroy:codebuild
```

This removes:
- CodeBuild projects
- IAM roles and policies
- CloudWatch Log Groups

**Note:** ECR repositories and container images are NOT deleted and must be removed manually if needed.

## Comparison: Docker vs CodeBuild

| Feature | Local Docker | CodeBuild |
|---------|-------------|-----------|
| **Requirements** | Docker installed | AWS account only |
| **Speed** | Fast (2-3 mins) | Slower (5-10 mins) |
| **Cost** | Free | ~$0.08 per build |
| **Consistency** | Depends on local env | Always consistent |
| **CI/CD Ready** | Requires runner setup | Native AWS integration |
| **Windows Support** | Requires WSL2/Desktop | Works anywhere |
| **Debugging** | Local logs | CloudWatch Logs |
| **Offline** | Yes | No (requires internet) |

## Advanced Configuration

### Parallel Builds

Build both containers simultaneously:

```bash
# Start both builds without waiting
npm run codebuild:nuke &
npm run codebuild:frontend &
wait
```

### Wait for Build Completion

Add `--wait` flag to monitor builds until completion:

```bash
npm run codebuild:build-and-push -- --wait
```

This will:
- Poll build status every 10 seconds
- Display real-time progress
- Exit with error code if build fails
- Useful for CI/CD pipelines

### Custom Build Environment Variables

Override environment variables in the CodeBuild project:

```typescript
// In isb-codebuild-stack.ts
const nukeCodeBuild = new DockerBuildProject(this, "NukeCodeBuild", {
  // ... other props
  environmentVariables: {
    CUSTOM_VAR: { value: "custom-value" },
    BUILD_ENV: { value: "production" },
  },
});
```

## Troubleshooting

### Build hangs or times out

**Symptoms:** Build status stays "IN_PROGRESS" for > 15 minutes

**Solutions:**
1. Check CloudWatch Logs for errors
2. Verify network connectivity to ECR
3. Increase timeout in `docker-build-project.ts`:
   ```typescript
   timeout: codebuild.Duration.minutes(30)
   ```

### Cannot find buildspec.yml

**Symptoms:** `Buildspec file does not exist`

**Solutions:**
1. Verify source repository structure matches expected layout
2. Check buildspec path in CodeBuild project configuration
3. Ensure GitHub branch contains the buildspec files

### Permission denied errors

**Symptoms:** `AccessDenied` when pushing to ECR

**Solutions:**
1. Verify CodeBuild role has ECR permissions
2. Check ECR repository policy allows access from CodeBuild
3. Ensure ECR repository exists in the specified region

## Next Steps

After successfully building containers:

1. **Deploy Container Stack** (if using ECS instead of CloudFront):
   ```bash
   npm run deploy:container
   ```

2. **Deploy Compute Stack** (standard deployment):
   ```bash
   npm run deploy:compute
   ```

3. **Verify images in ECR**:
   ```bash
   aws ecr describe-images --repository-name innovation-sandbox-nuke
   aws ecr describe-images --repository-name innovation-sandbox-frontend
   ```

## Support

For issues with CodeBuild builds:
1. Check CloudWatch Logs: `/aws/codebuild/<project-name>`
2. Review buildspec.yml syntax and commands
3. Verify AWS permissions and ECR repository configuration
4. Consult AWS CodeBuild documentation: https://docs.aws.amazon.com/codebuild/
