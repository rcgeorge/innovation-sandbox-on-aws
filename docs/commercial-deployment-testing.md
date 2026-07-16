# Commercial Deployment & Regression Testing — `feat/govcloud`

Record of deploying Innovation Sandbox on AWS to a **commercial** account and
regression-testing the `feat/govcloud` branch against it. The goal was to prove
that the GovCloud branch, with all GovCloud feature flags **off**, is
backward-compatible with a stock commercial deployment (no regression) before
testing GovCloud behavior on a real GovCloud partition.

/ **Date:** 2026-07-16 · **Mode:** `dev` · **Region:** `us-east-1`

---

## 1. Environment

Single-account topology — one commercial account serves as Organization
management account, IAM Identity Center account, and the ISB hub.

| Item | Value |
|---|---|
| Commercial account (default profile) | `890314022608` (partition `aws`) |
| Organization | `o-79b1l66jj8` (this account is management; SCPs enabled) |
| Organization root | `r-hi52` (used as `PARENT_OU_ID`) |
| IAM Identity Center instance | `ssoins-72239a1b13fdf36a` |
| Identity Store | `d-90675a8264` |
| AWS access portal | `https://instemic-demo.awsapps.com/start` |
| Namespace | `myisb` (see note) · **Managed regions:** `us-east-1` |

> **Note on namespace:** the upstream `npm run deploy:*` scripts do not thread
> the `.env` `NAMESPACE` through to CDK, so the deployment used the `cdk.json`
> default `myisb` rather than the requested `isbtest`. Purely a resource-name
> prefix; internally consistent. The `IsbManagedRegions` restriction (`us-east-1`)
> **did** apply (it is a real CloudFormation parameter).

---

## 2. Baseline deploy — upstream v1.2.13

Deployed stock upstream (`aws-solutions/innovation-sandbox-on-aws`, `main` @
`ddf31a4`, **v1.2.13**) to establish a clean commercial baseline.

- Deploy order: **AccountPool → IDC → Data → Compute**, all `CREATE_COMPLETE`.
- Account-cleaner used the **public** ECR image (`privateEcrRepo` empty) — no
  local Docker build required.
- Environment note: the AWS Solutions synthesizer shells out to the `zip` CLI;
  installed `zip` via scoop to enable synth on Windows.

**Outputs**

| Output | Value |
|---|---|
| Web UI (CloudFront) | `https://d1i01woxl22q4h.cloudfront.net` |
| REST API | `https://saykbz2k3c.execute-api.us-east-1.amazonaws.com/prod/` |
| IdP cert secret | `/InnovationSandbox/myisb/Auth/IdpCert` |

**Health checks**

| Check | Result |
|---|---|
| CloudFront serves SPA | HTTP 200, `<title>Innovation Sandbox on AWS</title>` |
| API without auth | HTTP 403 (correctly protected) |
| Identity Center groups created | `myisb_IsbAdminsGroup`, `myisb_IsbManagersGroup`, `myisb_IsbUsersGroup` |
| Sandbox OU created | `myisb_InnovationSandboxAccountPool` (existing OUs untouched) |

---

## 3. SSO wiring (IAM Identity Center)

ISB authenticates via SAML → Identity Center. Configured manually (the custom
SAML 2.0 app is a console flow; the CLI cannot create SAML auth methods):

- Custom **SAML 2.0 application** `InnovationSandbox-myisb`
  (`ins-722360b7da65d076`):
  - **ACS URL:** `https://d1i01woxl22q4h.cloudfront.net/api/auth/login/callback`
  - **SAML audience:** `https://d1i01woxl22q4h.cloudfront.net`
- **Attribute mapping:** Subject → `${user:email}` (format `emailAddress`) — ISB
  uses the SAML NameID as the user's email.
- **Group assignments:** all three ISB groups assigned to the app.
- `rcgeorge@gmail.com` added to `myisb_IsbAdminsGroup`.
- **ISB AppConfig global config** updated (hosted config **v2**, deployed):
  `idpSignInUrl`, `idpSignOutUrl`, `idpAudience`, `webAppUrl`,
  `awsAccessPortalUrl` set; `maintenanceMode: false`.
- **IdP signing certificate** (from the Identity Center SAML metadata) uploaded
  to the `IdpCert` secret.

**Login verification (baseline):** signed in end-to-end; ISB issued a JWT with
`{"user":{"email":"rcgeorge@gmail.com","roles":["Admin"]}}` — confirming
email-as-Subject **and** role resolution from Identity Center group membership.
Admin dashboard rendered.

---

## 4. Branch under test — `feat/govcloud`

Two changes landed on the branch before regression testing:

1. **Post-review hardening** (`ddc216e`) — fixes across all four GovCloud phases
   (SCP partition wiring, ALB S3 principal / WAF source-IP / health checks /
   deploy-time ENI population, cost-bridge end-date & fail-loud & retry,
   cross-partition STS endpoint, provisioning idempotency & retry/catch &
   mapping persistence, org-role permissions). All flag-gated; commercial synth
   unchanged. Covered by unit tests + a GovCloud-mode synth smoke test.
2. **Merged upstream v1.2.13** (`36933d5`) — brought the branch (cut before the
   release) up to v1.2.13. v1.2.13 is a **security patch**: `aws-nuke`
   v3.64.1 → v3.65.0 (Go stdlib CVEs), amazonlinux base image digest (sqlite /
   expat / libxml2 / python3 / util-linux CVEs), `js-yaml` CVE. Only conflict
   was `source/layers/dependencies/package-lock.json` (branch added the elbv2
   SDK client; release churned the lock) — resolved by regenerating the lock
   from the auto-merged `package.json`.

Post-merge: typecheck clean (common, infra, lambdas, frontend); GovCloud-mode
synth smoke test (6/6) passes; cost-service unit tests (8/8) pass. The two
commercial snapshot tests fail **only** on Windows CRLF line endings (a
pre-existing checkout artifact, identical on the pristine branch — not a content
change).

---

## 5. Regression analysis — `cdk diff` (flags OFF vs deployed commercial)

`cdk diff` of `feat/govcloud` (GovCloud flags off) against the live v1.2.13
commercial stacks. **Full record:** `cdk-diff-record.txt`.

| Stack | Differences |
|---|---|
| **Data** | **None** (zero diff) |
| **AccountPool** | 2 Lambda layers replaced (new content hash) |
| **IDC** | Same 2 layers + `SsoInstanceArn` `AllowedPattern` widened |
| **Compute** | Lambda code hashes + layers + account-cleaner buildspec + cleaner Step Function |

**The only changes are:**

1. **Code / dependency asset updates** — every Lambda gets a new code asset and
   the shared Common + Dependencies layers are replaced. This is the v1.2.13
   security patch plus the branch's (inert) hardening code landing.
2. **Three partition-portability tweaks, semantically neutral in the `aws`
   partition:**
   - IDC `SsoInstanceArn` regex widened `^arn:aws:sso:…` →
     `^arn:(aws|aws-us-gov|aws-cn):sso:…` (still validates commercial ARNs).
   - Account-cleaner CodeBuild gains an `AWS_PARTITION` env var
     (`Ref AWS::Partition` → `"aws"`) and uses `arn:${AWS_PARTITION}:…` in the
     buildspec; cleaner Step Function uses `arn:${AWS::Partition}:states:…`.
     Both resolve identically to `aws`.

**Key backward-compatibility signal:** **zero IAM statement changes, zero
security-group changes, no resource deletions** across all four stacks.

---

## 6. Regression deploy — `feat/govcloud` (flags OFF)

Deployed the branch over the commercial stacks (all flags off).

| Stack | Result |
|---|---|
| AccountPool | `UPDATE_COMPLETE` |
| IDC | `UPDATE_COMPLETE` |
| Data | unchanged (no diff — no-op) |
| Compute | `UPDATE_COMPLETE` |

**Post-deploy verification**

| Check | Result |
|---|---|
| CloudFront URL / API / secret ARNs | **Identical** to baseline (continuity) |
| ISB AppConfig auth config | **v2 still active** — SSO config survived the update |
| Web UI | HTTP 200; admin dashboard renders (Robert George) |
| Login | Works — no regression |
| Version | v1.2.13 |

### Result: PASS — no regression

Deploying `feat/govcloud` with GovCloud flags off updates code/dependencies
(delivering the v1.2.13 security fixes) and makes three partition-neutral
template tweaks, with **no change to IAM, security groups, resource structure,
or the running SSO/login experience.**

---

## 7. Not tested here (require the real GovCloud partition)

The GovCloud feature flags were **not** exercised on the commercial account,
because they are either unsafe or infeasible there:

- `isGovCloud=true` — would render the SCPs with `aws-us-gov` ARNs attached to a
  real `aws`-partition sandbox OU (malformed guardrails). Must run in an actual
  `aws-us-gov` org.
- `hostingMode=alb-s3` — deployable on commercial but makes the UI internal-only
  (private ALB) and tears down CloudFront; its real purpose is GovCloud (no
  CloudFront there).
- `enableCommercialBridge=true` — requires the separate `commercial-bridge` app
  + IAM Roles Anywhere (trust anchor / client cert) to be stood up first.
- `enableGovCloudAccountProvisioning=true` — requires the commercial-bridge and
  creates real cross-partition accounts.

**Next:** deploy and test on the real GovCloud account (`govcloud` profile,
`604110488194`, partition `aws-us-gov`). Tracked separately.

---

## Appendix — key identifiers

| | |
|---|---|
| Commercial account | `890314022608` (aws) |
| GovCloud account (next) | `604110488194` (aws-us-gov) |
| Fork | `github.com/rcgeorge/innovation-sandbox-on-aws` |
| Branch | `feat/govcloud` @ `36933d5` (hardening + v1.2.13) |
| Baseline upstream | `aws-solutions` main @ `ddf31a4` (v1.2.13) |
