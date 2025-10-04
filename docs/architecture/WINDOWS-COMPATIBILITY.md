# Windows Compatibility Changes

This document describes the changes made to enable Windows compatibility for building and deploying the Innovation Sandbox on AWS solution.

## Summary

The solution originally required Linux or MacOS for development and deployment. It now supports Windows environments for all core development and deployment workflows.

## Changes Made

### 1. Package Dependencies

Added the following npm packages to support cross-platform operations:

- **`dotenv`** - Loads environment variables from `.env` file in Node.js
- **`cross-env`** - Cross-platform environment variable handling (installed but not used in final solution)
- **`copyfiles`** - Cross-platform file copying (installed but not used in final solution)

### 2. Custom Environment Loading Script

Created `scripts/run-with-env.js` - a Node.js script that:
- Loads environment variables from `.env` file using `dotenv`
- Executes commands with those environment variables available
- Works identically on Windows, Linux, and MacOS
- Provides clear error messages if `.env` file is missing

**Usage:**
```shell
npm run with-env <command>
```

### 3. Updated npm Scripts

Modified all bash-dependent scripts in `package.json`:

**Before (bash-only):**
```json
"env:init": "cp .env.example .env",
"bootstrap": "source .env && npm run --workspace @amzn/innovation-sandbox-frontend build && npm run --workspace @amzn/innovation-sandbox-infrastructure cdk bootstrap",
"deploy:compute": "source .env && npm run --workspace @amzn/innovation-sandbox-frontend build && npm run --workspace @amzn/innovation-sandbox-infrastructure cdk deploy -- InnovationSandbox-Compute ..."
```

**After (cross-platform):**
```json
"env:init": "node -e \"require('fs').copyFileSync('.env.example', '.env')\"",
"with-env": "node scripts/run-with-env.js",
"bootstrap": "npm run --workspace @amzn/innovation-sandbox-frontend build && npm run with-env npm run --workspace @amzn/innovation-sandbox-infrastructure cdk bootstrap",
"deploy:compute": "npm run --workspace @amzn/innovation-sandbox-frontend build && npm run with-env npm run --workspace @amzn/innovation-sandbox-infrastructure cdk deploy -- InnovationSandbox-Compute ..."
```

### 4. Updated Scripts

The following npm scripts now work on Windows:

- `npm run env:init` - Create `.env` file
- `npm run bootstrap` - Bootstrap CDK
- `npm run deploy:all` - Deploy all stacks
- `npm run deploy:account-pool` - Deploy Account Pool stack
- `npm run deploy:idc` - Deploy IDC stack
- `npm run deploy:data` - Deploy Data stack
- `npm run deploy:compute` - Deploy Compute stack
- `npm run docker:build` - Build Docker image
- `npm run docker:login` - Login to ECR
- `npm run docker:push` - Push Docker image
- `npm run docker:build-and-push` - Complete Docker workflow

### 5. Documentation Updates

Updated:
- `README.md` - Added Windows to supported operating systems and included a note for Windows users
- `CLAUDE.md` - Added Windows compatibility section

## What Still Requires Linux/MacOS

The following operations still require Linux or MacOS:

- **`npm run build:s3`** - Uses `deployment/build-s3-dist.sh` bash script
- **`npm run build:open-source`** - Uses `deployment/build-open-source-dist.sh` bash script (if it exists)

These scripts are primarily used for creating distribution packages and are not required for local development and deployment.

## Testing Recommendations

To verify Windows compatibility:

1. Clone the repository on a Windows machine
2. Install Node.js 22
3. Run `npm install`
4. Run `npm run env:init`
5. Configure `.env` file with valid AWS account IDs and settings
6. Run `npm test` to verify tests work
7. Run `npm run build` to verify all packages build
8. Run `npm run deploy:all` to verify deployment (with valid AWS credentials)

## Migration Guide

For users currently using the solution on Linux/MacOS:

**No changes required!** All scripts remain backward compatible. The solution will work identically on existing Linux/MacOS environments.

## Technical Details

### Environment Variable Expansion

The `scripts/run-with-env.js` helper:
- Uses Node.js `child_process.spawn()` with `shell: true`
- Passes loaded environment variables via `env: process.env`
- Supports both `$VAR` (bash) and `%VAR%` (Windows) syntax through shell expansion
- Returns the same exit code as the executed command

### Why Not Use `cross-env` Directly?

While `cross-env` can set individual environment variables, it doesn't support loading an entire `.env` file. Our custom script provides a better developer experience by:
- Automatically loading all variables from `.env`
- Providing clear warnings if `.env` is missing
- Supporting complex commands with pipes and multiple arguments
- Maintaining compatibility with the existing `.env` file format
