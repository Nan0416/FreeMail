# Deploying FreeMail

This guide walks through a full FreeMail deployment: writing its config, deploying the stack, requesting SES production access, wiring up DNS, and the optional pieces (custom domains, inbound email). It ends with troubleshooting for the failure modes you're most likely to hit.

FreeMail is **single-tenant and single-region**: one deployment is one owner, in your own AWS account, pinned to **`us-east-1`**. That region is not a default you can change — inbound SES and the CloudFront ACM certificate both require `us-east-1`, and the config parser rejects anything else.

> **Using a coding agent?** The repo ships a setup prompt that runs this whole guide with you: [`.claude/skills/freemail-setup/SKILL.md`](../.claude/skills/freemail-setup/SKILL.md). In Claude Code, run **`/freemail-setup`** in the repo (or ask it to set up FreeMail); point any other agent at that file. It checks your tools, AWS account and your domain's public DNS, asks a few plain-language questions, writes and validates the config, runs `cdk deploy` once you say yes, and walks you through the steps after it. See [§2](#with-an-agent).

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Configure](#2-configure)
3. [Deploy](#3-deploy)
4. [SES production access (sandbox exit)](#4-ses-production-access-sandbox-exit)
5. [DNS and email authentication](#5-dns-and-email-authentication)
6. [Custom domains (required)](#6-custom-domains-required)
7. [Inbound email (optional)](#7-inbound-email-optional)
8. [Attachments](#8-attachments)
9. [Connect an agent](#9-connect-an-agent)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites

- **AWS account + credentials.** Configure a profile (`aws configure` / SSO) with permission to deploy the stack (CloudFormation, IAM, Lambda, API Gateway, S3, CloudFront, DynamoDB, SES, Route53, ACM, SNS).
- **Region `us-east-1`.** The only supported region. Make sure your CLI/CDK default region is `us-east-1` (or pass it explicitly).
- **Node.js 22** (see [`.nvmrc`](../.nvmrc); Node ≥ 20.19 works).
- **A domain you control.** You'll either import an existing Route53 hosted zone or have FreeMail create a new one — but if FreeMail creates it, you must be able to **delegate it**: set its name servers at your domain registrar or, for a subdomain zone such as `mail.example.com`, add `NS` records for it wherever the parent domain's DNS is hosted (see [§5](#5-dns-and-email-authentication)).
- **CDK bootstrap.** A one-time `cdk bootstrap` per account/region (covered below).

Clone and build once so the CLI binary and Lambda/web assets exist:

```sh
git clone https://github.com/Nan0416/FreeMail.git
cd FreeMail
npm install
npm run build   # tsc -b + the web SPA build (packages/web/dist)
```

> `npm run build` also builds the React SPA. If you deploy without it, the web bucket ships a committed placeholder instead of the real app — always build before deploying.

## 2. Configure

A deployment is configured by one file, **`freemail-config.json`** at the repo root — the single source of truth the CDK app reads at synth. There are three ways to write it. All three produce the same file, and [`freemail validate`](#validate-the-config) checks it however it was written.

### With an agent

The setup prompt, [`.claude/skills/freemail-setup/SKILL.md`](../.claude/skills/freemail-setup/SKILL.md) (`/freemail-setup` in Claude Code), writes the config as part of a full setup. It looks before it asks:

- **Your AWS account** — which profile, an existing `FreeMailStack` (a deploy would update it in place), CDK bootstrap, the SES sandbox, an active receipt rule set. With no AWS access set up yet, it walks you through connecting one.
- **Your domain's public DNS** — who serves it, whether it already receives mail and where, existing SPF/DMARC records, CAA records that would block the certificates, whether `app.` and `api.` are taken — and whether a Route53 zone in your account is the one the internet actually sees.

From that it recommends a setup — for example a subdomain zone such as `mail.<domain>` when your DNS is hosted elsewhere, on a name it has checked is unused, so nothing about your existing domain changes — and asks you only what you decide: which account, which domain, whether to receive mail (with the MX acknowledgement, [§7](#7-inbound-email-optional)). It writes the file and runs `npx freemail validate`.

It then shows you the `cdk diff`, deploys on your yes, tells you the exact name-server records to set if it created a zone, and afterwards helps with sign-in, SES production access and a quick API check. Its AWS access is read-only apart from `cdk bootstrap` and `cdk deploy`, and it never chooses or types your password. If the account already runs FreeMail, it rebuilds the current config from the stack and changes only what you ask.

### Interactively — `freemail init`

`freemail init` is an interactive CLI that writes the file. Run it from the repo root:

```sh
npx freemail init
```

It asks:

| Prompt                              | What it sets                              | Notes                                                                                                                                                                                                             |
| ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Existing Route53 hosted zone?**   | `hostedZone.mode` = `import` or `create`  | On `import` it lists your zones (needs AWS creds; falls back to manual entry). On `create`, FreeMail provisions a new zone you must delegate ([§5](#5-dns-and-email-authentication)).                             |
| **Email domain**                    | `emailDomain`                             | The zone apex **or a subdomain of it** — e.g. `example.com` or `mail.example.com`. Must be equal-to or under the hosted zone.                                                                                     |
| **Web-app domain** (required)       | `appDomain`                               | Where the SPA is served, e.g. `app.example.com`. See [§6](#6-custom-domains-required).                                                                                                                            |
| **API domain** (required)           | `apiDomain`                               | Where the API is served, e.g. `api.example.com`. Must differ from `appDomain`.                                                                                                                                    |
| **Existing verified SES identity?** | `sesIdentity.mode` = `import` or `create` | Say yes if the domain is **already** set up for SES (verified, with DKIM/SPF/DMARC). FreeMail then creates neither the identity nor those DNS records. See [§6b](#6b-using-an-existing-ses-identity-import-mode). |
| **Enable inbound email?**           | `inbound.enabled`                         | Off by default. If yes, a second prompt makes you **explicitly acknowledge the MX override** (`inbound.confirmInboundMx`). See [§7](#7-inbound-email-optional).                                                   |

The result looks like:

```jsonc
{
  "region": "us-east-1",
  "hostedZone": { "mode": "import", "zoneName": "example.com", "hostedZoneId": "Z0123456ABCDEF" },
  "emailDomain": "mail.example.com",
  "appDomain": "app.example.com", // required
  "apiDomain": "api.example.com", // required
  "sesIdentity": { "mode": "create" }, // "import" if the domain is already set up for SES
  "inbound": { "enabled": false, "confirmInboundMx": false },
}
```

The config is **fail-loud**: a malformed value (wrong region, an email/app/api domain outside the zone, a **missing** `appDomain` or `apiDomain`, inbound enabled without acknowledgement, an `appDomain` equal to `apiDomain`) is rejected at synth with a clear message, not silently defaulted.

### Where the config lives

There is exactly **one** location: **`freemail-config.json` at the repo root**. It is not configurable — no CDK context value, no environment variable, no precedence order — so "which config did this deploy use?" always has one answer.

The file is **gitignored** (it names your domains and hosted zone). **`freemail-config.template.json`** is committed beside it as a starting point.

### By hand

Copy the template and edit it:

```sh
cp freemail-config.template.json freemail-config.json
$EDITOR freemail-config.json
```

### Validate the config

```sh
npx freemail validate
```

It checks the repo-root `freemail-config.json` from anywhere in the repo, through the same loader `cdk deploy` uses, so a file that passes is one the deploy can load, and it lists every problem at once. It checks the file, not your account — it makes no AWS calls, so it cannot tell whether the hosted zone or SES identity the file names exist. The same validation runs again at synth.

## 3. Deploy

```sh
cd packages/infra
npx cdk bootstrap    # first time per account/region only
npx cdk deploy       # deploys FreeMailStack; reads ../../freemail-config.json
```

The Lambda handlers are bundled from source at synth (esbuild), so no separate handler build is needed — but the **web SPA must already be built** (`npm run build` from the root, per [§1](#1-prerequisites)).

### Stack outputs

`cdk deploy` prints outputs you'll use immediately:

| Output                                                                | Use                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **`WebAppUrl`**                                                       | Open this to sign in and use FreeMail. Custom app domain if configured, else the CloudFront URL.                                            |
| **`ApiCustomDomainUrl`**                                              | The API domain. Used by **both** the web app (cross-origin) and agents (`x-api-key`).                                                       |
| **`HostedZoneNameServers`**                                           | Present only when FreeMail **created** the zone. **Delegate the zone to these** to activate it (see [§5](#5-dns-and-email-authentication)). |
| **`SesProductionAccessNote`**                                         | A link to the SES account dashboard to request production access (see [§4](#4-ses-production-access-sandbox-exit)).                         |
| **`SesMailFromDomain`**, **`SesBounceComplaintTopicArn`**             | The custom MAIL FROM subdomain and the SNS topic that receives bounce/complaint notifications.                                              |
| **`MailBucketName`**, **`QuarantineBucketName`**, **`WebBucketName`** | The S3 buckets (mail and quarantine are retained on teardown — see [§10](#10-troubleshooting)).                                             |

### After deploying

1. Open **`WebAppUrl`** and **sign in**. There is no username — FreeMail is single-tenant. There is also no separate set-password step: on a fresh deployment the **first password submitted becomes the account password** (trust-on-first-use) and signs you in.

   > **Do this immediately after deploying.** Until the first sign-in the account is unclaimed, and the app is reachable by anyone who has the URL — whoever signs in first owns the deployment. The password is enrolled exactly once and stored hashed (scrypt); there is no re-set flow, so a typo on that first sign-in means clearing the password item from the auth DynamoDB table (`pk=auth`, `sk=password`) and signing in again.

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
- **DMARC** — a `_dmarc` TXT record at `p=none` (monitoring). When **inbound is enabled** it also carries `rua=mailto:dmarc@<emailDomain>`, so the daily aggregate reports land in your own mailbox via the catch-all receipt rule. With inbound off the tag is omitted — the domain has no MX, so nothing could deliver them. The reports are gzipped XML, not readable mail; point `rua` at a parsing service if you want a rendered summary.

You don't create these by hand — but they only take effect once the hosted zone is **live on the public internet**.

### If FreeMail created the hosted zone: delegate it

A newly **created** zone is not yet authoritative for its domain. Take its four name servers — the **`HostedZoneNameServers`** output once the deploy has finished, or the zone's `NS` record in the Route53 console as soon as the deploy has created it — and delegate:

- **A whole domain** (`example.com`): set them as the domain's name servers at your registrar (where you bought the domain).
- **A subdomain zone** (`mail.example.com`): add them as `NS` records for `mail` wherever `example.com`'s DNS is hosted. **Do not** change the domain's name servers at the registrar — that would move all of `example.com` to the new zone, which holds only FreeMail's records, and take the domain's website and mail down with it.

Until you do:

- SES DKIM/domain verification won't complete (SES verifies asynchronously and keeps retrying — no deploy failure),
- inbound MX (if enabled) won't route, and
- **the deploy will hang on certificate validation** — see the next section.

> If you **imported** an existing, already-delegated zone, there's nothing to do here — the records just appear.

### Other TXT values at the email domain

Route53 holds one `TXT` record per name, and in create mode the stack owns the one at `emailDomain`. So a site verification (Google Search Console, Microsoft 365, …) can't simply be added beside FreeMail's SPF value in Route53: a value added there by hand is dropped the next time the stack rewrites the record. List such values in the config instead, and FreeMail publishes them after its SPF value:

```json
"sesIdentity": {
  "mode": "create",
  "extraTxtValues": ["google-site-verification=…"]
}
```

Each value is one string of at most 255 printable ASCII characters, without `"` or `\`. An SPF value is refused: the record already carries FreeMail's `v=spf1 include:amazonses.com ~all`, and a second SPF value breaks SPF for the domain. Import mode refuses the option too — FreeMail writes no `TXT` record there, so the record is yours to edit.

If the zone already has a `TXT` record at `emailDomain` when you first deploy in create mode, the deploy fails with _"already exists"_. Move the values you want to keep (not its SPF value) into `extraTxtValues`, and delete the record before deploying. If that first deploy then fails and rolls back, the record it created is deleted too, so those values are missing from DNS until a deploy succeeds.

## 6. Custom domains (required)

`appDomain` (web app, a CloudFront alias) and `apiDomain` (API, a regional API Gateway custom domain) are **both required**. Each must be equal-to or a subdomain of your hosted zone, and the two must differ from each other.

They are not optional because the browser calls the API **cross-origin**: the API's CORS policy allowlists exactly one origin — your `appDomain` — and the SPA needs an absolute URL for `apiDomain`. There is no generated-CloudFront / generated-`execute-api` deployment shape, so a config missing either is rejected at parse.

FreeMail requests a **DNS-validated ACM certificate** for each (in `us-east-1`) and writes the validation records + alias records into the hosted zone.

### ⚠️ The #1 deploy footgun: delegate a created zone _before_ the first custom-domain deploy

**DNS-validated ACM certificates block the CloudFormation deploy until their validation records resolve publicly.** If your hosted zone was just **created** (`mode: create`) and has **not** yet been delegated, the validation records exist only in an un-delegated zone — so nothing can resolve them, and **`cdk deploy` hangs on certificate validation** (often until it times out).

Unlike SES DKIM (which verifies asynchronously _after_ the deploy and simply retries), **ACM validation gates the deploy**. So:

Because both domains are now required, **every** deploy provisions certificates — you cannot side-step this with a domain-less first deploy. So:

- **Import an already-delegated zone** (the smooth path), or
- If FreeMail creates the zone, delegate it ([§5](#if-freemail-created-the-hosted-zone-delegate-it)) **promptly during** the hanging deploy, so validation completes before CloudFormation gives up. The zone and its name servers appear in the Route53 console early in the deploy; the `HostedZoneNameServers` output only once it has finished.

FreeMail warns about this at synth time (a CDK annotation) whenever the zone is newly created, and emits a `CustomDomainValidationNote` output as a reminder.

## 6b. Using an existing SES identity (import mode)

If the domain is **already** a verified SES identity — you set up DKIM, SPF, a custom MAIL FROM, and DMARC yourself — set:

```json
"sesIdentity": { "mode": "import" }
```

FreeMail then creates **neither the SES identity nor any of its DNS auth records**. This is not a nicety: with `mode: "create"` against an already-configured domain the deploy **fails**, because `AWS::SES::EmailIdentity` has a fixed physical ID and errors with _"already exists"_, and a `CfnRecordSet` cannot create a DKIM/SPF/DMARC record that is already in the zone.

**What import mode does not change.** FreeMail still creates its own SES **configuration set**, SNS topic, and bounce/complaint logger, and the sender passes `ConfigurationSetName` explicitly on every send — so suppression, bounce/complaint events, and reputation metrics all work exactly as in create mode. Sending IAM is scoped to `arn:aws:ses:<region>:<account>:identity/<emailDomain>`, which is the same ARN whether FreeMail created the identity or not.

**What becomes your responsibility.** DKIM signing, SPF, DMARC, custom MAIL FROM, and keeping the identity verified. FreeMail does not check any of it at deploy — if the identity is not verified, sends fail at runtime, not at `cdk deploy`.

> ### ⚠️ Import mode does **not** protect your MX record
>
> Import mode only skips the identity and its _auth_ records. If you also enable **inbound**, FreeMail still points that domain's **MX** at SES ([§7](#7-inbound-email-optional)) — overriding however the domain receives mail today. Import mode is precisely the case where a working mail setup is likely to exist, so FreeMail emits an extra synth warning for this combination.
>
> If anything currently delivers mail to the domain, **receive on a dedicated subdomain** (`emailDomain: "mail.example.com"`) instead.

### Verifying the cross-origin setup

The browser↔API security depends on API Gateway behavior that cannot be checked from a synth or a unit test. After your first deploy, run [`CORS-VERIFICATION.md`](./CORS-VERIFICATION.md) — it is a short set of `curl` probes with explicit pass/fail criteria.

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

SES receipt rule → writes raw MIME to the mail S3 bucket → a parser Lambda extracts metadata, the decoded body, and attachments (honoring SES spam/virus verdicts) → indexes them in DynamoDB. The web app's **Inbox** tab then lists received mail; the reader renders HTML in a sandboxed iframe with a strict CSP. Inbound is region-restricted, and `us-east-1` (the pinned region) supports it.

**Failed mail goes to the Errors folder.** A message whose content can't be extracted — SES's virus scan did not return `PASS`, or the message is malformed, over the processing limits (more than 25 attachments, an attachment over 15 MB or 30 MB of attachments in total, or a 10 MB body), or larger than 40 MB — is listed in the web app's **Errors** folder with the reason, not in the Inbox. Nothing from it is rendered, but its original is copied to a separate **quarantine bucket** (no expiry) and stays downloadable as `.eml`; when SES did not confirm it virus-free, the download is marked suspicious and needs an explicit **Download anyway**.

**Raw messages are kept for 14 days once processed.** After the parser has stored what a message needs (its body and attachments, or its quarantined copy), SES's raw copy under `inbound/` is only needed for **Download original (.eml)**: the parser tags it, and a lifecycle rule deletes tagged copies after 14 days. For fully processed mail the `.eml` download is offered only while it is younger than that, and a body part over 1 MB keeps only its truncated stored copy afterwards. A raw copy that is still the only copy of a message is never tagged and never expires: a message whose processing dead-lettered (redrive it from the parser DLQ, which keeps events for 14 days), and anything received before tagging existed. Sent mail's original is kept permanently.

## 8. Attachments

Attachment bytes never travel through the API. Sending a file is two steps:

1. **Create an upload** — `POST /attachments/uploads` with `{ "filename", "contentType", "sizeBytes" }` (the web app does this for you; agents use the MCP tool `create_attachment_upload`). The response carries an `uploadId` and a presigned `uploadUrl`.
2. **PUT the file to `uploadUrl`** — straight to S3, with no credentials beyond the URL itself. The URL is valid for **15 minutes** and only for exactly the declared size. Then reference the file in the send: `"attachments": [{ "uploadId": "…" }]`.

To forward a file that is already on a message in the mailbox, skip both steps: reference it as `{ "emailId": "…", "attachmentId": "…" }` (the message id and the attachment's id from `GET /emails/{id}`), and the server copies it. Files of mail flagged as spam, or in the Errors folder, cannot be forwarded.

When the message is sent, each upload is copied to permanent storage and then:

- **Small files are embedded** in the outgoing MIME — each file up to **3 MB**, and up to **10 MB embedded per message** in total. Files are considered in order; one that would push the embedded total past 10 MB is linked instead, and a smaller one after it can still be embedded.
- **Larger files become a token-download link** in the email body — `GET /d/{token}`, which validates the token and 302-redirects to a short-lived presigned S3 URL. Recipients' links are valid for **30 days**. Your own copy in **Sent** never expires.
- **Between your own addresses**, a linked file also arrives as a regular attachment: when the message comes back in through inbound, each of your own download links is recognized and the file is attached to the received copy too — pointing at the same stored file, so it never expires there either. This needs your domain to pass DMARC (SES signs with DKIM for it, and a `_dmarc` record exists), so a message merely claiming your address as its From gets nothing; a link from a message you didn't send to one of your own addresses, or past the first 1 MiB of a very long body, stays a link.
- **Limits:** up to **20 attachments** per message, each up to **100 MB**. An upload that is never sent is deleted after a day.

To change the embed thresholds, add an optional `attachments` block to `freemail-config.json` and redeploy (values in bytes; per-file ≤ 15 MB, per-message ≤ 20 MB, since SES caps a message at 40 MB after base64):

```jsonc
"attachments": { "embedMaxBytes": 3145728, "embedTotalBytes": 10485760 }
```

A download-token **revoke** endpoint is [#35](https://github.com/Nan0416/FreeMail/issues/35).

## 9. Connect an agent

Agents send email through the MCP server — no browser, no cookies:

1. In the web app, open **MCP server** and **create an access key**. It's shown **once** (copy it then); it's stored hashed and can't be retrieved again. An access key authorizes an agent to **send and (when inbound is enabled) read the mailbox via the MCP server** — it does **not** grant key management or the REST mailbox-read routes, which require signing in to the web app with your password (the cookie session).
2. Point your MCP client at **`POST https://{apiDomain}/mcp`** with header **`x-api-key: fm_<your-key>`**. For Claude Code, the **MCP server** page shows a ready-to-paste `.mcp.json` that reads the key from `$FREEMAIL_API_KEY`.
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

To attach a file, first call **`create_attachment_upload`** with `{ "filename", "contentType", "sizeBytes" }`, PUT the file's bytes to the returned `uploadUrl` (an ordinary HTTPS PUT, no API key needed), then pass `"attachments": [{ "uploadId": "<from the tool>" }]` to `send_email`. To forward a file that is already on a message in the mailbox (inbound enabled), pass `{ "emailId", "attachmentId" }` from `get_email` instead — the server copies it, nothing is downloaded or uploaded. File bytes are never sent through MCP.

The MCP server is stateless (Streamable HTTP), so no session setup is required. **`send_email`** and **`create_attachment_upload`** are always available; when **inbound is enabled**, the read tools **`list_emails`**, **`get_email`**, and **`get_email_attachment_url`** are also registered, so agents can read received mail and mint short-lived presigned attachment download URLs. Received email is untrusted external content — the read tools return it marked as data (with a `trust` field and a delimited text frame), not as instructions to the agent. With inbound disabled, only `send_email` and `create_attachment_upload` are offered.

## 10. Troubleshooting

**Sending fails / recipient never gets the email.**
You're almost certainly still in the **SES sandbox** — you can only send to verified recipients there. Request [production access](#4-ses-production-access-sandbox-exit). Also confirm the `from` address is under your `emailDomain`.

**`cdk deploy` hangs at "waiting for certificate validation".**
A DNS-validated ACM cert can't validate because the hosted zone isn't publicly delegated. This happens when a **custom domain is configured on a freshly created zone**. Delegate the zone ([§5](#if-freemail-created-the-hosted-zone-delegate-it)) — at the registrar for a whole domain, or as `NS` records in the parent domain's DNS for a subdomain zone; never the registrar for a subdomain zone. Its name servers are in the Route53 console as soon as the deploy has created it (the `HostedZoneNameServers` output appears only once the deploy finishes). Validation completes once the delegation propagates. See [§6](#6-custom-domains-required). To avoid it entirely, import an already-delegated zone, or delegate as soon as the deploy has created the zone.

**Deploy fails: a `TXT` record at the email domain "already exists".**
In create mode FreeMail writes the `TXT` record at `emailDomain` (its SPF value), and the zone already has one. Keep its values other than SPF in `sesIdentity.extraTxtValues`, delete the record, and deploy again. See [§5](#other-txt-values-at-the-email-domain).

**DKIM/domain verification stays "pending" in SES.**
The hosted zone likely isn't delegated yet (see [§5](#5-dns-and-email-authentication)), so SES can't see the DKIM CNAMEs. Delegate the zone; SES retries automatically. Verify the records exist in Route53.

**Inbound deploy fails complaining about an active receipt rule set.**
Another SES receipt rule set is already active in this account/region. FreeMail refuses to override it. Deactivate the other set (SES console → Email receiving), or deploy to a dedicated account/region. See [§7](#7-inbound-email-optional).

**Inbound enabled but no mail arrives.**
Check that the `emailDomain`'s MX record points at SES and the zone is delegated. If you enabled inbound on a domain that already had mail routing, that routing was replaced — using a dedicated subdomain avoids this.

**Handling bounces and complaints.**
SES publishes bounce and complaint events to the SNS topic in the `SesBounceComplaintTopicArn` output; a subscribed Lambda logs them to CloudWatch, and SES suppression is enabled to protect your sending reputation. Watch that log group and the SES reputation dashboard, and stop mailing addresses that hard-bounce.

**`cdk destroy` left buckets and tables behind.**
By design. The four DynamoDB tables and the mail and quarantine S3 buckets use a `RETAIN` removal policy so a teardown never silently deletes your email or credentials. After a destroy they remain as orphaned resources — delete them by hand if you truly want them gone.
