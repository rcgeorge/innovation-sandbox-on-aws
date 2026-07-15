# GovCloud Support Plan

Status: in progress. This document tracks the plan to add AWS GovCloud (US)
support to Innovation Sandbox on AWS while remaining fully backward-compatible
with commercial deployments. It is intended to be delivered upstream, so every
GovCloud-specific behavior is feature-flagged and produces **no change** to
commercial synth output when its flag is off.

## Decisions

| Topic | Decision |
|---|---|
| Delivery target | Upstream PR to `aws-solutions`. All GovCloud behavior feature-flagged; commercial unchanged when flags off. |
| Partition handling | Use the `AWS::Partition` pseudo-parameter (`Stack.of(this).partition`). Resolves to `aws` in commercial, `aws-us-gov` in GovCloud. Backward-compatible by construction — no `isGovCloud` string hardcoding. |
| Obsolete workarounds | Drop the fork's CloudWatch-Events scheduler fallback and Application Insights skip — both services are now available in GovCloud. Re-test the WAF rate-based rule and keep if it synths. |
| Web UI hosting (GovCloud) | Private/internal only. ALB + S3 (via S3 interface VPC endpoint) + S3, in a VPC. Selected by `hostingMode=alb-s3`. |
| Cost tracking | Cost Explorer is not in GovCloud. Port the commercial-bridge cost API + `CommercialBridgeCostService` and **actually wire it into** lease-monitoring and cost-reporting (the fork left this mocked at $0). Auth via IAM Roles Anywhere (not the API-key path). |
| Account provisioning | Cross-partition automated account creation, gated behind an opt-in deploy-time flag `enableGovCloudAccountProvisioning`, default off. Zero footprint when off. |

## Feature flags (all default to commercial behavior)

| Flag (CFN param / CDK context) | Default | Effect when set |
|---|---|---|
| `hostingMode` | `cloudfront` | `alb-s3` → private ALB + S3 front door instead of CloudFront |
| `enableCommercialBridge` | `false` | `true` → cost bridge client + env wiring on lease-monitoring & cost-reporting |
| `enableGovCloudAccountProvisioning` | `false` | `true` → cross-partition account-creation Step Function + UI flow |

Partition is **not** a flag — it is always the resolved `AWS::Partition` token.

## Key facts about the current commercial solution (drives the design)

- CloudFront is a **unified same-origin front door**: it serves the SPA from S3
  at `/` and proxies `/api/*` to API Gateway, using CloudFront Functions to (a)
  rewrite extensionless paths → `index.html` for the `BrowserRouter` SPA and (b)
  strip the `/api` prefix. See
  `source/infrastructure/lib/components/cloudfront/cloudfront-ui-api.ts`.
- The frontend has **no `config.js`**. It derives the API base at runtime as
  `window.location.origin + "/api"` (`source/frontend/src/helpers/config.ts`),
  with an optional build-time `VITE_API_URL` override. **Same-origin is a hard
  assumption today.**
- Auth is **SAML via IAM Identity Center + a rotated JWT** — not Cognito. The
  SAML ACS/callback URL is tied to whatever origin serves the SPA.
- **No VPC** exists today; every Lambda runs outside a VPC. The ALB hosting mode
  introduces a VPC greenfield.
- The REST API defaults to **EDGE-optimized** (no explicit endpoint type). Must
  become `REGIONAL` for GovCloud.
- WAF is **regional, attached to the API Gateway stage**, and its IP-allowlist +
  rate rules key off `X-Forwarded-For`.

## Hosting design — ALB rule transforms (container-free, same-origin)

ALB supports server-side listener-rule **transforms** (`host-header-rewrite`,
`url-rewrite`), applied on forward to the target with no redirect/status change.
See https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-transforms.html.
This removes the need for a Fargate/nginx proxy or a Lambda proxy for `/api`,
and removes the need for a fallback Lambda for SPA deep links.

- **SPA (`/`)** → IP target group of the S3 **interface endpoint** ENIs.
  - `host-header-rewrite`: rewrite `Host` → the regional S3 endpoint /
    bucket-addressed host so S3 resolves the object.
  - `url-rewrite`: `^/[^.]*$` → `/index.html` gives SPA deep-link fallback
    (`GET /leases/123` refresh). Requests that match no pattern (e.g. `*.js`,
    `*.css`) are forwarded unchanged, so assets serve normally.
- **API (`/api/*`)** → IP target group of the **private API Gateway**
  `execute-api` interface endpoint ENIs.
  - `host-header-rewrite`: rewrite `Host` → `{apiId}.execute-api.{region}...`
    (API Gateway returns 403 if Host is not its own domain).
  - `url-rewrite`: `^/api/(.*)` → `/{stage}/$1` strips the `/api` prefix and
    injects the stage. Keeps same-origin — no frontend/SAML/CORS changes.
  - Verified safe: every ISB API handler returns small `application/json`; there
    are no file/CSV/binary/streaming responses.
- **ENI IPs are not static** → an ENI-IP sync Lambda (scheduled + endpoint
  change events) keeps both IP target groups current.
- **Verify before deploy**: confirm ALB rule transforms are available in the
  target GovCloud region (relatively recent feature); confirm the private API
  Gateway `execute-api` endpoint policy allows the VPC/endpoint.

## Phases

### Phase 0 — Partition correctness (safe, no flags, do first)
1. REST API → `EndpointType.REGIONAL`, gated on `hostingMode !== 'cloudfront'`
   so commercial keeps EDGE and shows no diff.
2. `${Stack.of(this).partition}` in account-cleaner step function + `AWS_PARTITION`
   var into the cleanup buildspec.
3. SCP JSON: substitute `${partition}` at synth (commercial stays `arn:aws:`).
4. `versionReporting: false` in `source/infrastructure/cdk.json` (verify no
   meaningful commercial diff — removes `AWS::CDK::Metadata`).
5. SSO instance ARN validation regex accepts `arn:aws-us-gov:sso`.
6. `EventSourceMapping` Tags deletion override (partition-conditional).
7. EventBus property simplification made **conditional** (commercial keeps
   `kmsKey`/DLQ).
8. Add GovCloud AppConfig extension layer ARNs (additive map entries).

### Phase 1 — Drop obsolete workarounds
- Do not port the scheduler fallback or App Insights skip. Re-test WAF
  rate-based rule.

### Phase 2 — Private ALB + S3 front door (`hostingMode=alb-s3`)
New construct `AlbS3UiApi` parallel to `CloudfrontUiApi`; commercial path
untouched. Components: VPC (2 AZ, isolated subnets); S3 interface endpoint +
`execute-api` interface endpoint; internal ALB (HTTPS via ACM, HTTP→HTTPS
redirect); two IP target groups (S3 ENIs, API GW ENIs) kept current by an
ENI-IP sync Lambda (scheduled every 5 min); explicit listener rules — API at
priority 10 (`/api/*`), SPA at priority 20 (`/*`), default action a fixed 404
(transforms cannot attach to a default rule); SPA `BucketDeployment` to the S3
bucket; WAF re-homed to the ALB. Frontend and SAML config unchanged (same-origin
preserved).

**Rule transforms** (`host-header-rewrite`, `url-rewrite`) are applied by a
custom resource (`Custom::AlbRuleTransforms`) because CDK L2 does not expose the
transform API. The handler (`apply-rule-transforms-handler.ts`) calls elbv2
`ModifyRule` on Create/Update:
- SPA rule: Host → `{bucket}.s3.{region}.{urlSuffix}`; `^/[^.]*$` → `/index.html`
  (deep-link fallback; `*.js`/`*.css` don't match and pass through).
- API rule: Host → `{apiId}.execute-api.{region}.{urlSuffix}`; `^/api/(.*)$` →
  `/{stage}/$1` (strip prefix, inject stage).
Requires `@aws-sdk/client-elastic-load-balancing-v2` (added to the dependencies
layer, pinned `^3.1087.0` — the version where the Transforms API landed).

**API Gateway PRIVATE endpoint** (done): in `alb-s3` mode the RestApi is a
`EndpointType.PRIVATE` endpoint bound to the shared `execute-api` interface
endpoint, with a resource policy allowing `execute-api:Invoke` only when
`aws:SourceVpce` equals that endpoint. To resolve the endpoint-policy →
VPC-endpoint ordering, networking is extracted into an `IsbPrivateNetwork`
construct created *before* the RestApi and shared with `AlbS3UiApi`. Commercial
mode passes no endpoint, so it keeps its default endpoint type and no policy
(synth output unchanged — verified by snapshot tests).

### Phase 3 — Cost bridge, fully wired (`enableCommercialBridge=true`)

**GovCloud side (done):**
- `AccountsCostReport` extracted to `isb-services/cost/accounts-cost-report.ts`
  (no SDK import); `cost-explorer-service.ts` re-exports it for back-compat.
- `ICostService` interface (`isb-services/cost/cost-service.ts`) covering the
  three externally-used methods: `getCostForLeases`, `getCostForRange`,
  `getDailyCostsByAccount`. `CostExplorerService implements ICostService`.
- `CommercialBridgeClient` (Roles Anywhere only — no API-key path; uses
  `execFileSync` not shell `execSync` to avoid injection) and
  `CommercialBridgeCostService implements ICostService` (all three methods).
- `IsbServices.costService()` factory selects the bridge impl when
  `isCommercialBridgeConfigured(env)` (full Roles Anywhere set present),
  otherwise Cost Explorer. The three cost lambdas now call `costService()`.
- `commercialLinkedAccountId?` added to sandbox-account schema (v1→v2, optional;
  migration test proves v1 records still validate).
- CDK wiring via `commercial-bridge-config.ts` helper: bridge env vars +
  `ACCOUNT_TABLE_NAME` + Secrets Manager read + account-table read added to
  lease-monitoring, cost-reporting, group-cost-reporting **only when
  enableCommercialBridge is set**. Commercial synth is byte-clean (verified: 0
  `COMMERCIAL_BRIDGE` vars in a no-flag Compute template).

**Commercial-partition side (remaining):** the `roles-anywhere-helper` Lambda
layer (bundling `aws_signing_helper` at `/opt/bin/`) and the commercial-bridge
cost API (API Gateway + `cost-information` Lambda querying Cost Explorer, with a
Roles Anywhere trust anchor/profile) deployed to the commercial account. These
are independently deployable cross-partition infrastructure.

### Phase 4 — Optional cross-partition provisioning (`enableGovCloudAccountProvisioning=true`, default off)
Commercial-bridge account-creation + accept-invitation Lambdas, GovCloud
account-creation Step Function v3, flag-gated frontend "Create GovCloud Account"
flow. Rewrite the PoC container/handlers cleanly (no TLS-disabled / `ACAO:*` /
hardcoded-dev-login code from the fork).

## PR strategy
Stacked PRs: (0) partition + drop-workarounds → (2) hosting behind flag → (3)
cost bridge → (4) provisioning. Each independently backward-compatible.

## Security notes
- Rotate the API key exposed in the fork's `GOVCLOUD-IMPLEMENTATION.md` before
  anything ships. Do not reuse the API-key auth path — Roles Anywhere only.
- Do not carry forward the fork's PoC proxy container (disables TLS validation,
  `Access-Control-Allow-Origin: *`, hardcoded dev credentials, `NODE_ENV=development`).
