@echo off
set AWS_PROFILE=commercial
cd infrastructure
npx cdk deploy --all --require-approval never
