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

## Hosting limits that shape the ALB + S3 design

- S3 **REST** endpoint (reachable over PrivateLink) has **no `index.html` error
  fallback** → SPA deep-link refresh (`GET /leases/123`) 404s. Handled by a tiny
  Lambda ALB target returning `index.html`.
- ALB **cannot rewrite the Host header** → the SPA bucket is named to match the
  internal domain so virtual-host/path addressing resolves without rewrite.
- ALB **→ Lambda response ≤ 1 MB** (hard cap) → only the tiny `index.html`
  router Lambda is on that path (well under 1 MB). JS bundles are served from S3,
  not through Lambda.
- S3 **interface endpoint ENI IPs are not static** → an ENI-IP sync Lambda keeps
  the ALB target group current.
- `/api/*` path: preserve same-origin by routing `/api/*` through the same ALB to
  a **private API Gateway** deployed under an `/api` base-path mapping (ALB
  cannot strip prefixes). Fallback if base-path mapping proves painful: split
  origin via build-time `VITE_API_URL` + CORS + SAML ACS reconfig.

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
untouched. VPC, S3 interface endpoint, domain-matched SPA bucket, private Route53
+ ACM, internal ALB (HTTPS + HTTP→HTTPS redirect), ENI-IP sync Lambda,
`index.html` fallback Lambda target, private API Gateway under `/api` base-path
mapping, WAF re-homed to the private API stage.

### Phase 3 — Cost bridge, fully wired (`enableCommercialBridge=true`)
`ICostService` + `CommercialBridgeCostService` + `CommercialBridgeClient`;
factory selects impl by partition/flag. `commercialLinkedAccountId?` on
sandbox-account schema. Commercial cost API deployed to commercial partition with
IAM Roles Anywhere auth + `roles-anywhere-helper` layer. Connect into
lease-monitoring + cost-reporting handlers (env vars, Secrets Manager + DynamoDB
perms) replacing the mock $0 report.

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
