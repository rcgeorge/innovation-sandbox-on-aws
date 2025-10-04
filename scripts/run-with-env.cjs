#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// This script loads environment variables from .env file and executes a command
// Usage: node scripts/run-with-env.js <command> [args...]

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
const [,, ...args] = process.argv;

if (args.length === 0) {
  console.error('Error: No command provided');
  process.exit(1);
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
