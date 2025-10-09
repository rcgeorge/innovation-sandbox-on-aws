#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// This script loads environment variables from .env file and executes a command
// Usage: node scripts/run-with-env.js <command> [args...] [--profile <profile-name>]

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load .env file
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  console.warn('Warning: .env file not found. Run "npm run env:init" first.');
}

// Get command and arguments - join everything after the script name
let args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Error: No command provided');
  process.exit(1);
}

// Parse --profile parameter and set AWS_PROFILE if provided
const profileArgIndex = args.findIndex(arg => arg.startsWith('--profile'));
if (profileArgIndex !== -1) {
  const profileArg = args[profileArgIndex];
  let profileValue;

  // Handle both --profile=name and --profile name formats
  if (profileArg.includes('=')) {
    profileValue = profileArg.split('=')[1];
  } else if (args[profileArgIndex + 1] && !args[profileArgIndex + 1].startsWith('--')) {
    profileValue = args[profileArgIndex + 1];
    // Remove both --profile and the value
    args.splice(profileArgIndex, 2);
  } else {
    console.error('Error: --profile requires a value');
    console.error('Usage: --profile <profile-name> or --profile=<profile-name>');
    process.exit(1);
  }

  // Only remove --profile=value if we haven't already removed both args
  if (profileArg.includes('=')) {
    args.splice(profileArgIndex, 1);
  }

  // Set AWS_PROFILE environment variable (overrides .env)
  process.env.AWS_PROFILE = profileValue;
  console.log(`Using AWS profile: ${profileValue}`);
}

// If no --profile was provided, check for context-specific profile env vars
// This allows different profiles for GovCloud vs Commercial deployments
if (!process.env.AWS_PROFILE) {
  // Check if this is a commercial bridge command
  const isCommercialCommand = args.some(arg =>
    arg.includes('commercial-bridge') ||
    arg.includes('commercial:')
  );

  if (isCommercialCommand && process.env.AWS_COMMERCIAL_PROFILE) {
    process.env.AWS_PROFILE = process.env.AWS_COMMERCIAL_PROFILE;
    console.log(`Using commercial profile from AWS_COMMERCIAL_PROFILE: ${process.env.AWS_PROFILE}`);
  } else if (!isCommercialCommand && process.env.AWS_GOVCLOUD_PROFILE) {
    process.env.AWS_PROFILE = process.env.AWS_GOVCLOUD_PROFILE;
    console.log(`Using GovCloud profile from AWS_GOVCLOUD_PROFILE: ${process.env.AWS_PROFILE}`);
  }
  // Otherwise fall back to AWS SDK default credential chain
  // (AWS_PROFILE from .env, environment variables, EC2/ECS instance roles, etc.)
}

// Join all arguments into a single command string
let commandString = args.join(' ');

// Replace environment variable placeholders with actual values
// This handles both $VAR and ${VAR} syntax
commandString = commandString.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (match, varName) => {
  // Use empty string if env var is defined but empty, otherwise keep original if undefined
  return varName in process.env ? (process.env[varName] || '') : match;
});

// Execute command with environment variables using shell
const child = spawn(commandString, {
  stdio: 'inherit',
  shell: true,
  env: process.env
});

child.on('exit', (code) => {
  process.exit(code || 0);
});

child.on('error', (err) => {
  console.error('Failed to execute command:', err);
  process.exit(1);
});
