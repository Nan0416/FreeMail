# FreeMail — Design

FreeMail is a **self-hosted, single-tenant, open-source email service for agents and humans**, built on AWS SES. Deploy it into your own AWS account with one CDK deploy: you get a web app to read/send email and an **MCP server** so your agents can send email — under your own domain, with effectively unlimited addresses.

Status: **Design note / shaping.** Decisions marked ✅ are agreed.

## Principles
- **Single-tenant, self-hosted.** One deployment = one user, in the user's own AWS account. No multi-tenant SaaS.
- **Agent-first.** A first-class MCP server for agents to send and (when inbound is enabled) read email, authed by API key.
- **Own your domain + data.** SES + Route53 + S3 in the user's account.

## Tech stack
TypeScript · npm workspaces monorepo · Node.js (Lambda) · React (SPA) · AWS CDK (TypeScript) · default region **us-east-1**.

## AWS architecture
- **AWS SES** — sending (any address under the domain → "infinite addresses"); optional inbound (receiving → S3).
- **AWS Route53** — domain + email-auth records (SPF, DKIM, custom MAIL FROM, DMARC).
- **API Gateway (HTTP API) + Lambda** — two route groups: (1) REST API for the React app; (2) MCP server for agents.
- **CloudFront + S3** — hosts the React SPA (same domain).
- **DynamoDB** — auth (password hash, refresh tokens), API keys (hashed), email metadata/index, large-attachment download tokens.
- **S3** — inbound raw emails + parsed attachments; outbound attachments (uploaded directly via presigned PUT).

## Auth ✅
- **Single-tenant password, trust-on-first-use** (#42). There is no separate set-password step: the **first login on an unclaimed deployment enrolls** the submitted password — hashed (scrypt, Lambda-safe) into DDB under an atomic `attribute_not_exists` write, so exactly one concurrent caller can win — and signs that caller in. Every later login verifies normally. No username. Whoever reaches the login route first owns the deployment, so claim it immediately after deploying.
- **Login** issues **access + refresh** tokens (JWT; HS256 signing key generated on first use and persisted as a singleton row in the auth DDB table — no Secrets Manager dependency, #42). Refresh rotation. Login endpoint **rate-limited / lockout** (single-password brute-force protection).
- **Web session = httpOnly cookies** (#31). Both tokens ride in `HttpOnly; Secure; SameSite=Strict; Path=/` cookies (`__Host-fm_access` / `__Host-fm_refresh`) the browser stores but page JS cannot read — no token in any web storage, so XSS cannot exfiltrate the session. The SPA holds no token and sends `credentials: 'include'` with no `Authorization` header; refresh/logout read the refresh token **only** from the cookie (never a body/query), and every refresh failure clears both cookies. Auth responses are `Cache-Control: no-store`.
- **CSRF: three coupled layers** (#47, superseding the #31/#15-R2 "same-origin proxy, no CORS" invariant — the CloudFront `/api/*` proxy is gone and the browser calls the API cross-origin at `apiDomain`). No single layer covers every case:
  1. **`SameSite=Strict` + `__Host-`** — a *foreign* site cannot make the cookies ride at all, and the cookies are host-locked to `apiDomain` (no `Domain`, so no sibling can shadow or receive them).
  2. **Exact-single-origin credentialed CORS** — the API allowlists exactly one origin (`appDomain`), never a wildcard and never a reflected request origin, with `Vary: Origin`. This is the response-**read** boundary and the preflight gate.
  3. **Non-simple request shape** — every state-changing route requires `Content-Type: application/json` (parsed, not string-compared: case-insensitive, parameters tolerated), rejected before any side effect. Includes the *bodyless* `POST /auth/refresh` and `/auth/logout`, which are otherwise "simple" and could be ridden by a sibling form-POST to force a logout.
  Layers 2 and 3 are **jointly necessary** for the same-site-sibling case (`evil.example.com`), where Strict does nothing because the request *is* same-site: layer 3 forces a preflight, layer 2 refuses it. A double-submit CSRF token stays **deferred** behind these.
- **CORS is not authorization.** A foreign, `null`, malformed, or absent `Origin` merely gets no usable CORS headers; the request still reaches the Lambda authorizer, which remains the sole authorization boundary. Agents send no `Origin` and are entirely unaffected.
- **Both `appDomain` and `apiDomain` are required config** — a browser deployment needs a canonical app origin to allowlist and an absolute API origin to call.
- **API keys** for agents → the MCP server. Registered via the React app; stored **hashed**, shown raw once. **One key = full agent access over MCP: send AND (when inbound is enabled) read the mailbox**, plus `GET /api/emails/{id}` for backend services — but **not** key management and **not** the REST mailbox-read routes, which stay cookie-session only (no per-key scopes for v1). Validated by a **Lambda authorizer** (the agent `x-api-key` path is unchanged by the cookie work).
- **API Gateway itself is unauthenticated; auth lives in the backend** (a Lambda authorizer covers both the web access-token cookie and API keys), on every route.

## APIs
1. **REST API** (React app): login (enrolls on first use), refresh/logout, send email, manage API keys; (with inbound) list/read emails + attachment download.
2. **MCP server** (agents): `send_email`, plus `list_emails` / `get_email` / `get_email_attachment_url` (read tools, registered only when inbound is enabled). Built with the official **`@modelcontextprotocol/sdk`** Streamable HTTP transport in **stateless mode** behind API GW + Lambda (request/response tool-calling; no server-push needed). API-key auth via the Lambda authorizer.
3. **Backend services**: `GET /api/emails/{id}`, authorized with an **API key** (`x-api-key`) by the same Lambda authorizer as MCP, returns a message with 5-minute presigned attachment URLs. With inbound enabled, an SNS topic notifies them of each received message (metadata only, at-least-once).

## Sending ✅
The SES domain identity is normally **created** by FreeMail together with its DKIM/SPF/MAIL-FROM/DMARC records; `sesIdentity.mode: "import"` adopts a domain that is **already** set up for SES, creating neither (both would fail the deploy as "already exists"). Import mode keeps FreeMail's configuration set, because the sender names it on every call rather than relying on the identity's default association — so suppression and bounce/complaint handling are unaffected.

`SES SendRawEmail` — send from **any address under the domain**. Requires **SES production access** (sandbox exit) per AWS account — a documented required manual step. Bounces/complaints via SNS → suppression + logging (reputation). **Delivery tracking:** every send carries SES message tags (row id + send time), and a tracker Lambda on the same topic records each report — delivered, bounced, complained, delayed, rejected — on the sent message's row, moving its status forward only (`sent` → `delivered` → `bounced`).

## Inbound (optional) ✅
- **Off by default.** Enabled via deploy config (`enableInbound`) with an explicit **MX-override warning** (inbound points the domain's MX at SES → **recommend a dedicated subdomain** so it doesn't clobber existing mail).
- SES receipt rule → **S3** (raw MIME) → Lambda parses (`mailparser`) → metadata to DDB + attachments to S3. SES spam/virus verdicts handled.
- Inbound is **region-restricted**; us-east-1 (the default) supports it.

### What happens to each received message

Every processed message gets a row in the **same** emails table; the cases differ in the row's flags and in what is stored. Two terms:
- **The quarantine bucket** holds the raw `.eml` of a *failed* message, with no expiry.
- **The `quarantined` flag** on a row means "hidden by default". It's set for both failed and spam messages.

The logic lives in `packages/service/src/processors/inbound-processor.ts`, with the exposure rule in `utils/verdicts.ts` and the limits in `utils/inbound-limits.ts`.

| # | Case | Row | Body and attachments stored | Raw copy to quarantine bucket | Shown in |
|---|---|---|---|---|---|
| 1 | Bad S3 key (not `inbound/<id>`) | None: `skipped`, logged, not retried | – | – | Nowhere |
| 2 | S3 object already gone | None: `skipped` | – | – | Nowhere |
| 3 | **Too big**: raw message over 40 MB, never downloaded, only the headers are read | `failed` (`oversize`) | No | Yes | Errors, with sender, subject and verdicts |
| 4 | **Over processing limits**: more than 25 attachments, one over 15 MB, more than 30 MB of attachments, or a body over 10 MB | `failed` (`limit_exceeded`) | No (partial uploads deleted) | Yes | Errors |
| 5 | **Malformed MIME** | `failed` (`parse_failed`) | No | Yes | Errors |
| 6 | **Virus verdict not exactly `PASS`**: `FAIL`, `GRAY`, `PROCESSING_FAILED`, or the header missing, duplicated or unknown | `failed` | No | Yes | Errors, with the `.eml` download marked suspicious |
| 7 | **Spam `FAIL`**, virus `PASS` | `quarantined` | Yes (own-link files skipped) | No | Inbox, tagged spam, content hidden until opened |
| 8 | **Good**: virus `PASS`, spam not `FAIL`, parsed OK | Normal | Yes, plus own-link files | No | Inbox |
| 9 | **Duplicate delivery** of the same S3 event | Already exists (conditional write): `duplicate` | Same keys, overwritten | – | No change |
| 10 | **Infrastructure error** (S3, DynamoDB or SNS failure) | Not yet — or, for an SNS failure, already written | – | – | Lambda retries twice, then the dead-letter queue (14 days) |

- **Where content lives:** attachment bytes are always separate S3 objects (`attachments/inbound/<id>/<part>`). The row only holds descriptors. The body is stored inline in the row (up to 256 KB) or as `bodies/inbound/<id>.json` (`storeEmailBody`).
- **Raw MIME:** once a row is written (cases 3–8), SES's raw copy under `inbound/` is tagged and expires after 14 days. In case 10 it is never tagged, so it stays until the event is redriven.
- **Case 3 is rare:** SES itself won't store a message over 40 MB in S3, so the check is mostly a safety net.
- **Notifications:** cases 7 and 8, and a redelivery of either (case 9), publish an `email.received` message to the SNS topic (`<stack>-email-received`), right after the row is written and before the raw MIME is tagged. A failed publish fails the invocation; the retry hits case 9 and publishes again. Delivery is at-least-once as long as dead-lettered events are redriven: an SNS outage longer than Lambda's two retries (a few minutes) leaves the message in the inbox but its notification in the parser's dead-letter queue, and its raw MIME untagged (kept). See DEPLOY.md, "New-mail notifications".

## Forwarding ✅
With inbound enabled, rules re-send received mail to outside addresses. A rule matches on the sender (domain or address) and/or the To/Cc recipients (domain or address); see DEPLOY.md §7, "Forwarding". The owner edits them on the web app's Forwarding page.
- **Rewrite and resend, not "Fwd:".** SES sends only From a verified identity, so the copy can't claim the original sender. It's the original raw MIME with `From` rewritten to `forwarding@<domain>` ("Alice (alice@x.com) via <domain>"), `Reply-To` set to the sender, and the sender, signature and SES receipt headers dropped. The body bytes are untouched (`utils/forward-mime.ts`). The recipient reads the real email and a reply goes to the sender. A "Fwd:" message would need the body rebuilt, and replies would come back here.
- **A subscriber, not a step in the parser.** A queue subscribed to the `email-received` topic (spam filtered out by the subscription, raw delivery) feeds the forwarder Lambda. A failed send retries and dead-letters without re-running ingest, and the parser, which reads untrusted MIME, never holds `ses:SendEmail`.
- **A queue, not a direct Lambda subscription.** Lambda's async retries give up after about 3 minutes, so an SES throttle or pause would dead-letter every forward in it. The queue retries for about half an hour (5 receives, 6 minutes apart). A dead-lettered notification can be redriven from the SQS console, disabling the event source pauses forwarding for up to 14 days, and at most 2 forwards run at once (one notification each).
- **The notification decides most of it.** Rules are first matched against the notification's From/To/Cc, as if the sender were authenticated, so most mail matches nothing and costs only the rules scan, with no read of its row or raw MIME. A possible match reads the row (strongly consistent: the duplicate guard, the raw key, and the stored To/Cc, which the notification would carry cut short if a future storage cap exceeded its 50), then the raw MIME (kept 14 days): the copy is made from it, and SES's DMARC result is in its headers.
- **Every rule requires DMARC pass, unless it opts out.** The copy is re-sent and DKIM-signed by this domain without the original's authentication headers, so its recipient can't check the sender; the forwarder must. Without the check, a rule on `customer.com` would forward anyone claiming that From, and a recipient rule would forward anything a stranger addressed or Cc'd. `ignoreDmarcVerification` turns it off for one rule, for senders without DMARC. It's off unless `true`, so a rule stored without it is checked, and it makes that rule's sender conditions forgeable. A copy of mail whose sender didn't pass then says so (`(unverified)` in the From name, `X-FreeMail-Sender-Verified: no`, any such header the message brought dropped), since this domain's signature would otherwise vouch for whoever the From claimed.
- **Once, normally; never zero.** The notification is at-least-once, so the row's `forward` is the duplicate guard, written after the send. A crash in between, or two copies of a notification processed at the same moment (up to 2 run at once), can forward twice, which beats never forwarding; a claim-before-send would close that, at the cost of a stuck claim on a crash. A rejection SES will repeat (`MessageRejected`, `BadRequestException`) is skipped rather than retried.
- **Loops** are cut by the `X-FreeMail-Forwarded` marker, by never forwarding to the own domain, and by never forwarding a reply to a forward: mail addressed to `forwarding@<domain>`, or an RFC 3834 `auto-replied` message. `auto-generated` mail is forwarded; notifications are much of what people forward.
- **Not in the Sent folder:** nothing one of your addresses wrote, so the forward is recorded on the received message instead.
- **Rules: their own small table, scanned per message.** One row per rule, keyed by a random id (which is what each forward records). The forwarder scans it for every notification, with no cache, so a saved or paused rule applies to the next message; a handful of rows is one cheap scan. A malformed row is skipped and logged, never fatal to the others.
- **One check, shared.** `checkForwardingRule` (`@freemail/shared`) trims, lowercases and de-duplicates, validates domains and addresses, needs a condition and a target, and caps the lists. The REST service enforces it with the email domain, refusing targets there (a loop), and the web page pre-runs it, so the two never disagree.
- **Owner only.** `/forwarding-rules` is `requireAccessScheme`-guarded like key management: an agent's API key could otherwise add a rule copying all received mail out.
- **The forwarder holds only what a forward needs.** On the emails table: `GetItem` and `UpdateItem` held to the `INBOUND` partition (`dynamodb:LeadingKeys`), the update to the `forward` attribute (`dynamodb:Attributes`, with the key attributes DynamoDB requires) returning nothing; on the rules table, `Scan`; on the mail bucket, reads under `inbound/`; and SES send only From `forwarding@<domain>` (`ses:FromAddress`).

## Attachments ✅
- **Inbound (received):** parsed to S3, downloaded by the **authenticated app user** via **presigned S3 URLs**.
- **Outbound upload:** the client never sends bytes through the API — it gets a **presigned S3 PUT** (`POST /attachments/uploads`, or the MCP tool `create_attachment_upload`), uploads directly, and the send references the `uploadId`. Up to 100 MB per file. A file already on a stored message can be **forwarded** instead — `{ emailId, attachmentId }` — and the server copies it (not from spam-flagged or Errors-folder mail).
- **Outbound small (≤ 3 MB each, ≤ 10 MB per message; configurable):** **embedded in the MIME** (SendRawEmail) — the recipient's provider serves it. (SES caps the message at 40 MB; keep the threshold conservative.)
- **Outbound large:** the **Gmail→Drive / iCloud→Mail-Drop pattern** — upload to S3, put a **download link in the email body** → a **token endpoint** (`GET /d/{token}` → validate token in DDB → 302 to a presigned S3 GET), with a configurable expiry (e.g. 30 days) + revocation. (A raw presigned URL is rejected here — 7-day max, non-revocable, leaks the bucket.)
- **Own-domain recipients:** when a message to one of your own addresses comes back in through inbound, its own `/d/{token}` links are matched to their tokens and — when SES's DMARC check passed for the From domain and the token was minted by that same sender for a message with an own-domain recipient — the linked files become real attachments on the received copy (pointing at the sent copy — permanent, no bytes copied).

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
