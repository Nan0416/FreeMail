# Deploying FreeMail

This guide walks through a full FreeMail deployment: configuring it with `freemail init`, deploying the stack, requesting SES production access, wiring up DNS, and the optional pieces (custom domains, inbound email). It ends with troubleshooting for the failure modes you're most likely to hit.

FreeMail is **single-tenant and single-region**: one deployment is one owner, in your own AWS account, pinned to **`us-east-1`**. That region is not a default you can change — inbound SES and the CloudFront ACM certificate both require `us-east-1`, and the config parser rejects anything else.

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Configure — `freemail init`](#2-configure--freemail-init)
3. [Deploy](#3-deploy)
4. [SES production access (sandbox exit)](#4-ses-production-access-sandbox-exit)
5. [DNS and email authentication](#5-dns-and-email-authentication)
6. [Custom domains (optional)](#6-custom-domains-optional)
7. [Inbound email (optional)](#7-inbound-email-optional)
8. [Attachments](#8-attachments)
9. [Connect an agent](#9-connect-an-agent)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites

- **AWS account + credentials.** Configure a profile (`aws configure` / SSO) with permission to deploy the stack (CloudFormation, IAM, Lambda, API Gateway, S3, CloudFront, DynamoDB, SES, Route53, ACM, Secrets Manager, SNS).
- **Region `us-east-1`.** The only supported region. Make sure your CLI/CDK default region is `us-east-1` (or pass it explicitly).
- **Node.js 22** (see [`.nvmrc`](../.nvmrc); Node ≥ 20.19 works).
- **A domain you control.** You'll either import an existing Route53 hosted zone or have FreeMail create a new one — but if FreeMail creates it, you must be able to **set the zone's name servers at your domain registrar** (see [§5](#5-dns-and-email-authentication)).
- **CDK bootstrap.** A one-time `cdk bootstrap` per account/region (covered below).

Clone and build once so the CLI binary and Lambda/web assets exist:

```sh
git clone https://github.com/Nan0416/FreeMail.git
cd FreeMail
npm install
npm run build   # tsc -b + the web SPA build (packages/web/dist)
```

> `npm run build` also builds the React SPA. If you deploy without it, the web bucket ships a committed placeholder instead of the real app — always build before deploying.

## 2. Configure — `freemail init`

`freemail init` is an interactive CLI that writes **`freemail.config.json`** — the single source of truth the CDK app reads at synth. Run it from the repo root:

```sh
npx freemail init
```

It asks:

| Prompt                               | What it sets                             | Notes                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Existing Route53 hosted zone?**    | `hostedZone.mode` = `import` or `create` | On `import` it lists your zones (needs AWS creds; falls back to manual entry). On `create`, FreeMail provisions a new zone you must delegate at your registrar. |
| **Email domain**                     | `emailDomain`                            | The zone apex **or a subdomain of it** — e.g. `example.com` or `mail.example.com`. Must be equal-to or under the hosted zone.                                   |
| **Custom web-app domain** (optional) | `appDomain`                              | Blank → the generated CloudFront domain. See [§6](#6-custom-domains-optional).                                                                                  |
| **Custom API domain** (optional)     | `apiDomain`                              | Blank → the generated API Gateway domain. Must differ from `appDomain`.                                                                                         |
| **Enable inbound email?**            | `inbound.enabled`                        | Off by default. If yes, a second prompt makes you **explicitly acknowledge the MX override** (`inbound.confirmInboundMx`). See [§7](#7-inbound-email-optional). |

The result looks like:

```jsonc
{
  "region": "us-east-1",
  "hostedZone": { "mode": "import", "zoneName": "example.com", "hostedZoneId": "Z0123456ABCDEF" },
  "emailDomain": "mail.example.com",
  "appDomain": "app.example.com", // optional
  "apiDomain": "api.example.com", // optional
  "inbound": { "enabled": false, "confirmInboundMx": false },
}
```

The config is **fail-loud**: a malformed value (wrong region, an email/app/api domain outside the zone, inbound enabled without acknowledgement, an `appDomain` equal to `apiDomain`) is rejected at synth with a clear message, not silently defaulted.

By default the file is written to `./freemail.config.json` (repo root), which is exactly where the CDK app looks. To write elsewhere, use `-o <path>` and point the CDK app at it with `-c configPath=<path>` or the `FREEMAIL_CONFIG` env var.

## 3. Deploy

```sh
cd packages/infra
npx cdk bootstrap    # first time per account/region only
npx cdk deploy       # deploys FreeMailStack; reads ../../freemail.config.json
```

The Lambda handlers are bundled from source at synth (esbuild), so no separate handler build is needed — but the **web SPA must already be built** (`npm run build` from the root, per [§1](#1-prerequisites)).

### Stack outputs

`cdk deploy` prints outputs you'll use immediately:

| Output                                                    | Use                                                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`WebAppUrl`**                                           | Open this to set your password and use FreeMail. Custom app domain if configured, else the CloudFront URL.                                         |
| **`ApiEndpoint`**                                         | The HTTP API base URL. Also the target of the CloudFront `/api` proxy and the MCP endpoint (`{ApiEndpoint}/mcp`).                                  |
| **`ApiCustomDomainUrl`**                                  | Present only if you set `apiDomain` — a branded host for direct agent/`x-api-key` access.                                                          |
| **`HostedZoneNameServers`**                               | Present only when FreeMail **created** the zone. **Set these at your registrar** to activate the zone (see [§5](#5-dns-and-email-authentication)). |
| **`SesProductionAccessNote`**                             | A link to the SES account dashboard to request production access (see [§4](#4-ses-production-access-sandbox-exit)).                                |
| **`SesMailFromDomain`**, **`SesBounceComplaintTopicArn`** | The custom MAIL FROM subdomain and the SNS topic that receives bounce/complaint notifications.                                                     |
| **`MailBucketName`**, **`WebBucketName`**                 | The S3 buckets (retained on teardown — see [§10](#10-troubleshooting)).                                                                            |

### After deploying

1. Open **`WebAppUrl`** and **set your password** on first visit. There is no username — FreeMail is single-tenant. The password is stored hashed; you can set it exactly once (re-setting requires clearing the auth record).
2. **Request SES production access** ([§4](#4-ses-production-access-sandbox-exit)) before sending to arbitrary recipients.
3. If FreeMail created your zone, **delegate its name servers** ([§5](#5-dns-and-email-authentication)) so email auth and (if enabled) inbound actually work.

## 4. SES production access (sandbox exit)

**This step is required, manual, and per-AWS-account. It cannot be automated, and it is not global — it applies to the specific account (and region) you deployed into.**

Every AWS account starts SES in **sandbox mode**, which means:

- you can only send **to verified email addresses/domains**, and
- you're subject to reduced sending quotas and a lower send rate.

The exact sandbox quotas are set by AWS, vary by account, and change over time — FreeMail doesn't control them, so check the current values in the AWS docs and your SES console rather than relying on a number here: [Amazon SES sending quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html) and [the SES sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

To send to arbitrary recipients you must **request production access**:

1. Open the SES console → **Account dashboard** (the `SesProductionAccessNote` output links straight there), in **`us-east-1`**.
2. Choose **Request production access** and describe your use case, expected volume, and how you handle bounces/complaints.
3. AWS reviews the request manually. Until it's granted, you remain in the sandbox.

Nothing in `cdk deploy` can grant this — it's an AWS account-level decision. Plan for it: deploy early, request production access, and keep testing against verified recipients in the meantime.

## 5. DNS and email authentication

FreeMail creates the email-authentication records in your hosted zone automatically:

- **DKIM** (Easy DKIM CNAMEs) — signs outbound mail.
- **SPF** — a TXT record authorizing SES for the send domain.
- **Custom MAIL FROM** — a `bounce.<emailDomain>` subdomain (MX + SPF) so bounce handling and DMARC alignment work.
- **DMARC** — a `_dmarc` TXT record at `p=none` (monitoring).

You don't create these by hand — but they only take effect once the hosted zone is **live on the public internet**.

### If FreeMail created the hosted zone: delegate it at your registrar

A newly **created** zone is not yet authoritative for your domain. Take the **`HostedZoneNameServers`** output and set those name servers at your domain registrar (where you bought the domain). Until you do:

- SES DKIM/domain verification won't complete (SES verifies asynchronously and keeps retrying — no deploy failure),
- inbound MX (if enabled) won't route, and
- **a custom-domain deploy will hang** — see the next section.

> If you **imported** an existing, already-delegated zone, there's nothing to do here — the records just appear.

## 6. Custom domains (optional)

`appDomain` (web app, a CloudFront alias) and `apiDomain` (API, a regional API Gateway custom domain for direct agent/`x-api-key` access) are both optional and independent. Each must be equal-to or a subdomain of your hosted zone, and the two must differ from each other. When unset, FreeMail uses the generated CloudFront / API Gateway domains and creates no certificate.

When set, FreeMail requests a **DNS-validated ACM certificate** (in `us-east-1`) and writes the validation records + alias records into the hosted zone.

### ⚠️ The #1 deploy footgun: delegate a created zone _before_ the first custom-domain deploy

**DNS-validated ACM certificates block the CloudFormation deploy until their validation records resolve publicly.** If your hosted zone was just **created** (`mode: create`) and has **not** yet been delegated at your registrar, the validation records exist only in an un-delegated zone — so nothing can resolve them, and **`cdk deploy` hangs on certificate validation** (often until it times out).

Unlike SES DKIM (which verifies asynchronously _after_ the deploy and simply retries), **ACM validation gates the deploy**. So:

- **Import an already-delegated zone**, or
- If FreeMail creates the zone, run a **first deploy without custom domains** to obtain the `HostedZoneNameServers`, delegate them at your registrar, and _then_ add `appDomain`/`apiDomain` and deploy again; **or** set the name servers at your registrar _promptly during_ the hanging deploy so validation can complete.

FreeMail warns about this at synth time (a CDK annotation) whenever a custom domain is configured on a created zone, and emits a `CustomDomainValidationNote` output as a reminder.

## 7. Inbound email (optional)

Inbound is **off by default**. Receiving mail requires pointing your email domain's **MX record at AWS SES**, which is a destructive change to that domain's mail routing — so FreeMail makes you opt in explicitly.

### Enabling it

During `freemail init`, answer **yes** to "Enable inbound email?" You'll then get an explicit warning and a second confirmation that sets `inbound.confirmInboundMx: true`. Both flags must be set:

```jsonc
"inbound": { "enabled": true, "confirmInboundMx": true }
```

If `inbound.enabled` is `true` but `confirmInboundMx` is not, the deploy **fails** at synth — the acknowledgement is enforced independently of the CLI.

### ⚠️ The MX-override risk — use a dedicated subdomain

Enabling inbound sets the MX record for your `emailDomain` to SES, **overriding any existing mail routing** for that domain. If your apex domain already receives mail (e.g. Google Workspace), pointing its MX at SES will **break that**. **Use a dedicated subdomain** (e.g. `mail.example.com`) as your `emailDomain` so inbound doesn't clobber email you already receive.

### Region-wide receipt rule set (fail-safe activation)

SES receipt rule sets are an **account-global, region-wide singleton** — only one can be active per region. FreeMail activates its own set safely: if a **different** receipt rule set is already active in this account/region, the **deploy fails** rather than silently overriding it. Deactivate the other set (or deploy FreeMail to a dedicated account/region) before enabling inbound.

### How inbound works once enabled

SES receipt rule → writes raw MIME to the mail S3 bucket → a parser Lambda extracts metadata + attachments (honoring SES spam/virus verdicts) → indexes them in DynamoDB. The web app's **Inbox** tab then lists received mail; the reader renders HTML in a sandboxed iframe with a strict CSP. Inbound is region-restricted, and `us-east-1` (the pinned region) supports it.

## 8. Attachments

- **Small attachments (≤ 3 MB each)** are embedded directly in the outgoing MIME message.
- **Larger attachments (> 3 MB)** are uploaded to S3 and replaced with a **token-download link** in the email body — `GET /d/{token}`, which validates the token and 302-redirects to a short-lived presigned S3 URL. Links are valid for **30 days**.
- **Each send is capped at ~7 MB total.** The whole request (subject, body, and all attachment bytes) arrives base64-encoded in a single API Gateway request body, so the practical ceiling is ~7 MB decoded — well under API Gateway's 10 MB limit.

**Not yet shipped:** sending **truly large files (> 10 MB)** needs a direct-to-S3 upload path that bypasses the API Gateway body limit — that's tracked as [#34](https://github.com/Nan0416/FreeMail/issues/34) and is **not** available today. A download-token **revoke** endpoint is [#35](https://github.com/Nan0416/FreeMail/issues/35). Don't assume a size ceiling beyond the ~7 MB per-send budget.

## 9. Connect an agent

Agents send email through the MCP server — no browser, no cookies:

1. In the web app, open **API keys** and **create a key**. It's shown **once** (copy it then); it's stored hashed and can't be retrieved again. An API key authorizes **sending only** (via the REST/MCP send routes) — reading the mailbox and managing keys require signing in to the web app with your password (the cookie session), not an API key.
2. Point your MCP client at **`POST {ApiEndpoint}/mcp`** (or `https://{apiDomain}/mcp` if you set a custom API domain) with header **`x-api-key: fm_<your-key>`**.
3. Call the **`send_email`** tool. A valid call needs **`from`** (an address under your domain), **at least one recipient** across `to`/`cc`/`bcc`, and **at least one body** — `text` and/or `html`:

```jsonc
{
  "name": "send_email",
  "arguments": {
    "from": "assistant@yourdomain.com",
    "to": ["someone@example.com"],
    "subject": "Hello",
    "text": "Body text",
    "html": "<p>Optional HTML body</p>",
  },
}
```

The MCP server is stateless (Streamable HTTP), so no session setup is required. **`send_email` is the only tool today** — agent read tools are roadmap ([#13](https://github.com/Nan0416/FreeMail/issues/13)).

## 10. Troubleshooting

**Sending fails / recipient never gets the email.**
You're almost certainly still in the **SES sandbox** — you can only send to verified recipients there. Request [production access](#4-ses-production-access-sandbox-exit). Also confirm the `from` address is under your `emailDomain`.

**`cdk deploy` hangs at "waiting for certificate validation".**
A DNS-validated ACM cert can't validate because the hosted zone isn't publicly delegated. This happens when a **custom domain is configured on a freshly created zone**. Set the zone's name servers (`HostedZoneNameServers` output) at your registrar — validation completes once they propagate. See [§6](#6-custom-domains-optional). To avoid it entirely, import an already-delegated zone, or do a first deploy without custom domains.

**DKIM/domain verification stays "pending" in SES.**
The hosted zone likely isn't delegated at the registrar yet (see [§5](#5-dns-and-email-authentication)), so SES can't see the DKIM CNAMEs. Delegate the zone; SES retries automatically. Verify the records exist in Route53.

**Inbound deploy fails complaining about an active receipt rule set.**
Another SES receipt rule set is already active in this account/region. FreeMail refuses to override it. Deactivate the other set (SES console → Email receiving), or deploy to a dedicated account/region. See [§7](#7-inbound-email-optional).

**Inbound enabled but no mail arrives.**
Check that the `emailDomain`'s MX record points at SES and the zone is delegated. If you enabled inbound on a domain that already had mail routing, that routing was replaced — using a dedicated subdomain avoids this.

**Handling bounces and complaints.**
SES publishes bounce and complaint events to the SNS topic in the `SesBounceComplaintTopicArn` output; a subscribed Lambda logs them to CloudWatch, and SES suppression is enabled to protect your sending reputation. Watch that log group and the SES reputation dashboard, and stop mailing addresses that hard-bounce.

**`cdk destroy` left buckets and tables behind.**
By design. The four DynamoDB tables and both S3 buckets use a `RETAIN` removal policy so a teardown never silently deletes your email or credentials. After a destroy they remain as orphaned resources — delete them by hand if you truly want them gone.
