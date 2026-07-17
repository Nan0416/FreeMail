# FreeMail — Design

FreeMail is a **self-hosted, single-tenant, open-source email service for agents and humans**, built on AWS SES. Deploy it into your own AWS account with one CDK deploy: you get a web app to read/send email and an **MCP server** so your agents can send email — under your own domain, with effectively unlimited addresses.

Status: **Design note / shaping.** Decisions marked ✅ are agreed.

## Principles
- **Single-tenant, self-hosted.** One deployment = one user, in the user's own AWS account. No multi-tenant SaaS.
- **Agent-first.** A first-class MCP server for agents to send (and later read) email, authed by API key.
- **Own your domain + data.** SES + Route53 + S3 in the user's account.

## Tech stack
TypeScript · npm workspaces monorepo · Node.js (Lambda) · React (SPA) · AWS CDK (TypeScript) · default region **us-east-1**.

## AWS architecture
- **AWS SES** — sending (any address under the domain → "infinite addresses"); optional inbound (receiving → S3).
- **AWS Route53** — domain + email-auth records (SPF, DKIM, custom MAIL FROM, DMARC).
- **API Gateway (HTTP API) + Lambda** — two route groups: (1) REST API for the React app; (2) MCP server for agents.
- **CloudFront + S3** — hosts the React SPA (same domain).
- **DynamoDB** — auth (password hash, refresh tokens), API keys (hashed), email metadata/index, large-attachment download tokens.
- **S3** — inbound raw emails + parsed attachments; outbound large attachments.

## Auth ✅
- **Single-tenant password.** On first open the user sets a password → stored **hashed** (argon2/bcrypt, Lambda-safe) in DDB. No username.
- **Login** issues **access + refresh** tokens (JWT; signing key in SSM/Secrets Manager). Refresh rotation. Login endpoint **rate-limited / lockout** (single-password brute-force protection).
- **Web session = httpOnly cookies** (#31). Both tokens ride in `HttpOnly; Secure; SameSite=Strict; Path=/` cookies (`__Host-fm_access` / `__Host-fm_refresh`) the browser stores but page JS cannot read — no token in any web storage, so XSS cannot exfiltrate the session. The SPA holds no token and sends `credentials: 'include'` with no `Authorization` header; refresh/logout read the refresh token **only** from the cookie (never a body/query), and every refresh failure clears both cookies. Auth responses are `Cache-Control: no-store`.
- **CSRF = `SameSite=Strict`.** To make Strict cookies work (they are dropped on cross-site requests), the SPA is served **same-origin** with the API: CloudFront proxies `/api/*` to the HTTP API, so the browser only ever talks to one origin and there is **no CORS**. A double-submit CSRF token is **deferred** behind Strict.
- **API keys** for agents → the MCP server. Registered via the React app; stored **hashed**, shown raw once. **One key = full access** (no per-key scopes for v1). Validated by a **Lambda authorizer** (the agent `x-api-key` path is unchanged by the cookie work).
- **API Gateway itself is unauthenticated; auth lives in the backend** (a Lambda authorizer covers both the web access-token cookie and MCP API-keys).

## APIs
1. **REST API** (React app): set-password/login, send email, manage API keys; (with inbound) list/read emails + attachment download.
2. **MCP server** (agents): `send_email` (+ later `list_emails`/`get_email`). Built with the official **`@modelcontextprotocol/sdk`** Streamable HTTP transport in **stateless mode** behind API GW + Lambda (request/response tool-calling; no server-push needed). API-key auth via the Lambda authorizer.

## Sending ✅
`SES SendRawEmail` — send from **any address under the domain**. Requires **SES production access** (sandbox exit) per AWS account — a documented required manual step. Bounces/complaints via SNS → suppression + logging (reputation).

## Inbound (optional) ✅
- **Off by default.** Enabled via deploy config (`enableInbound`) with an explicit **MX-override warning** (inbound points the domain's MX at SES → **recommend a dedicated subdomain** so it doesn't clobber existing mail).
- SES receipt rule → **S3** (raw MIME) → Lambda parses (`mailparser`) → metadata to DDB + attachments to S3. SES spam/virus verdicts handled.
- Inbound is **region-restricted**; us-east-1 (the default) supports it.

## Attachments ✅
- **Inbound (received):** parsed to S3, downloaded by the **authenticated app user** via **presigned S3 URLs**.
- **Outbound small (≤ ~10 MB):** **embedded in the MIME** (SendRawEmail) — the recipient's provider serves it. (SES caps the message at 40 MB; keep the threshold conservative.)
- **Outbound large:** the **Gmail→Drive / iCloud→Mail-Drop pattern** — upload to S3, put a **download link in the email body** → a **token endpoint** (`GET /d/{token}` → validate token in DDB → 302 to a presigned S3 GET), with a configurable expiry (e.g. 30 days) + revocation. (A raw presigned URL is rejected here — 7-day max, non-revocable, leaks the bucket.)

## Deploy UX ✅
A small **`npx freemail init`** CLI prompts for:
1. Existing Route53 **hosted zone**? If yes → the domain (imported); if no → created.
2. **Email domain** (same or subdomain of the zone).
3. **React app domain** (optional; default = CloudFront domain).
4. **API domain** (optional; default = API Gateway domain).
5. **Enable inbound?** (+ MX-override warning + explicit confirm).

It writes a config (CDK context), then `cdk deploy`. (CDK isn't interactive, so the init CLI + synth-time `Annotations` warnings carry the "ask + warn" UX.) CloudFront ACM certs live in us-east-1 — pinning the default region avoids cross-region cert stacks.

## Build order
- **Phase 1 — Send + auth + agent MCP (first shippable):** monorepo scaffold · CDK base + init CLI · SES sending + DNS auth · single-tenant auth · API keys · REST send · MCP send tool · React app (login + compose/send + key mgmt) on CloudFront/S3.
- **Phase 2 — Inbound + read:** SES receipt → S3 · MIME parsing → DDB/S3 · REST list/read + attachment download · React inbox/reader (safe HTML) · MCP read tools.
- **Phase 3 — Large attachments + custom domains + docs:** outbound token download flow · custom SPA/API domains · README + SES production-access guide.

## Firmed decisions
| Decision | State |
|---|---|
| Single-tenant, self-hosted (one deploy = one user, user's AWS account) | ✅ |
| Default region us-east-1 (inbound-supported + CloudFront cert region) | ✅ |
| Password-only auth (no username), hashed in DDB; access+refresh JWT | ✅ |
| API keys: hashed, shown once, **one key = full access** (no scopes in v1) | ✅ |
| Auth in backend (Lambda authorizer); API Gateway unauthenticated | ✅ |
| MCP: official SDK, Streamable HTTP **stateless** on API GW + Lambda | ✅ |
| Send from any address under the domain (SES production access required) | ✅ |
| Inbound optional, off by default, MX-override warned, dedicated subdomain recommended | ✅ |
| Attachments: inbound = presigned; outbound small = embed; outbound large = token endpoint | ✅ |
| Deploy via `freemail init` CLI → config → cdk deploy | ✅ |
