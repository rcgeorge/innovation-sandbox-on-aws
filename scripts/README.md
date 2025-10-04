# Scripts

This directory contains utility scripts for the Innovation Sandbox on AWS solution.

## Available Scripts

### configure.cjs

Interactive configuration wizard that guides users through setting up their `.env` file.

**Usage:**
```shell
npm run configure
```

**Features:**
- **Auto-detection of AWS Environment**:
  - Current AWS account ID (via `aws sts get-caller-identity`)
  - Configured AWS region (via `aws configure get region` or environment variables)
  - IAM Identity Center information (via `aws sso-admin list-instances`)
  - AWS Organizations root ID (via `aws organizations list-roots`)
- **Single vs Multi-Account**: Choose between single-account (all stacks in one account) or multi-account deployment
- **Smart defaults**: Uses detected values to pre-populate configuration fields
- Prompts for all required environment variables with validation
- Validates inputs (AWS account IDs, region formats, OU IDs, etc.)
- Shows existing values as defaults when reconfiguring
- Handles optional configuration (private ECR, custom nuke config, deployment mode)
- Generates a properly formatted `.env` file
- Provides deployment-specific next steps

**Dependencies:**
- `inquirer` - For interactive CLI prompts
- `fs` - For file operations
- `dotenv` - Implicitly used by reading .env.example structure

### run-with-env.cjs

Helper script that loads environment variables from `.env` file and executes commands with those variables available.

**Usage:**
```shell
npm run with-env <command>
```

**Example:**
```shell
npm run with-env docker build -t myimage:latest .
```

**Features:**
- Loads all variables from `.env` file using `dotenv`
- Executes commands in a shell with environment variables set
- Works cross-platform (Windows, Linux, MacOS)
- Returns the same exit code as the executed command
- Provides clear warning if `.env` file is missing

**Dependencies:**
- `dotenv` - For loading .env files
- `child_process` - For spawning shell commands

### detect-empty-files.sh

Shell script to detect empty files in the repository (used for validation).

**Note:** This is a bash script and requires Linux/MacOS or WSL on Windows.

## File Naming Convention

Scripts use the `.cjs` extension (CommonJS) because the main `package.json` specifies `"type": "module"`. This allows these scripts to use CommonJS `require()` syntax while the rest of the project uses ES modules.
