# Deploying FreeMail

This guide walks through a full FreeMail deployment: configuring it with `freemail init`, deploying the stack, requesting SES production access, wiring up DNS, and the optional pieces (custom domains, inbound email). It ends with troubleshooting for the failure modes you're most likely to hit.

FreeMail is **single-tenant and single-region**: one deployment is one owner, in your own AWS account, pinned to **`us-east-1`**. That region is not a default you can change — inbound SES and the CloudFront ACM certificate both require `us-east-1`, and the config parser rejects anything else.

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Configure — `freemail init`](#2-configure--freemail-init)
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

`freemail init` is an interactive CLI that writes **`freemail-config.json`** at the repo root — the single source of truth the CDK app reads at synth. Run it from the repo root:

```sh
npx freemail init
```

It asks:

| Prompt                              | What it sets                              | Notes                                                                                                                                                                                                             |
| ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Existing Route53 hosted zone?**   | `hostedZone.mode` = `import` or `create`  | On `import` it lists your zones (needs AWS creds; falls back to manual entry). On `create`, FreeMail provisions a new zone you must delegate at your registrar.                                                   |
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

Prefer not to use the interactive CLI? Copy the template and edit it:

```sh
cp freemail-config.template.json freemail-config.json
$EDITOR freemail-config.json
```

Either way the same schema validation runs at synth.

## 3. Deploy

```sh
cd packages/infra
npx cdk bootstrap    # first time per account/region only
npx cdk deploy       # deploys FreeMailStack; reads ../../freemail-config.json
```

The Lambda handlers are bundled from source at synth (esbuild), so no separate handler build is needed — but the **web SPA must already be built** (`npm run build` from the root, per [§1](#1-prerequisites)).

### Stack outputs

`cdk deploy` prints outputs you'll use immediately:

| Output                                                    | Use                                                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`WebAppUrl`**                                           | Open this to sign in and use FreeMail. Custom app domain if configured, else the CloudFront URL.                                                   |
| **`ApiEndpoint`**                                         | The HTTP API base URL. Also the target of the CloudFront `/api` proxy and the MCP endpoint (`{ApiEndpoint}/mcp`).                                  |
| **`ApiCustomDomainUrl`**                                  | The API domain. Used by **both** the web app (cross-origin) and agents (`x-api-key`).                                                              |
| **`HostedZoneNameServers`**                               | Present only when FreeMail **created** the zone. **Set these at your registrar** to activate the zone (see [§5](#5-dns-and-email-authentication)). |
| **`SesProductionAccessNote`**                             | A link to the SES account dashboard to request production access (see [§4](#4-ses-production-access-sandbox-exit)).                                |
| **`SesMailFromDomain`**, **`SesBounceComplaintTopicArn`** | The custom MAIL FROM subdomain and the SNS topic that receives bounce/complaint notifications.                                                     |
| **`MailBucketName`**, **`WebBucketName`**                 | The S3 buckets (retained on teardown — see [§10](#10-troubleshooting)).                                                                            |

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

### If FreeMail created the hosted zone: delegate it at your registrar

A newly **created** zone is not yet authoritative for your domain. Take the **`HostedZoneNameServers`** output and set those name servers at your domain registrar (where you bought the domain). Until you do:

- SES DKIM/domain verification won't complete (SES verifies asynchronously and keeps retrying — no deploy failure),
- inbound MX (if enabled) won't route, and
- **the deploy will hang on certificate validation** — see the next section.

> If you **imported** an existing, already-delegated zone, there's nothing to do here — the records just appear.

## 6. Custom domains (required)

`appDomain` (web app, a CloudFront alias) and `apiDomain` (API, a regional API Gateway custom domain) are **both required**. Each must be equal-to or a subdomain of your hosted zone, and the two must differ from each other.

They are not optional because the browser calls the API **cross-origin**: the API's CORS policy allowlists exactly one origin — your `appDomain` — and the SPA needs an absolute URL for `apiDomain`. There is no generated-CloudFront / generated-`execute-api` deployment shape, so a config missing either is rejected at parse.

FreeMail requests a **DNS-validated ACM certificate** for each (in `us-east-1`) and writes the validation records + alias records into the hosted zone.

### ⚠️ The #1 deploy footgun: delegate a created zone _before_ the first custom-domain deploy

**DNS-validated ACM certificates block the CloudFormation deploy until their validation records resolve publicly.** If your hosted zone was just **created** (`mode: create`) and has **not** yet been delegated at your registrar, the validation records exist only in an un-delegated zone — so nothing can resolve them, and **`cdk deploy` hangs on certificate validation** (often until it times out).

Unlike SES DKIM (which verifies asynchronously _after_ the deploy and simply retries), **ACM validation gates the deploy**. So:

Because both domains are now required, **every** deploy provisions certificates — you cannot side-step this with a domain-less first deploy. So:

- **Import an already-delegated zone** (the smooth path), or
- If FreeMail creates the zone, take the `HostedZoneNameServers` from the created zone and set them at your registrar **promptly during** the hanging deploy, so validation completes before CloudFormation gives up. Delegating first, then deploying, is easier if you can.

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

SES receipt rule → writes raw MIME to the mail S3 bucket → a parser Lambda extracts metadata + attachments (honoring SES spam/virus verdicts) → indexes them in DynamoDB. The web app's **Inbox** tab then lists received mail; the reader renders HTML in a sandboxed iframe with a strict CSP. Inbound is region-restricted, and `us-east-1` (the pinned region) supports it.

## 8. Attachments

- **Small attachments (≤ 3 MB each)** are embedded directly in the outgoing MIME message.
- **Larger attachments (> 3 MB)** are uploaded to S3 and replaced with a **token-download link** in the email body — `GET /d/{token}`, which validates the token and 302-redirects to a short-lived presigned S3 URL. Links are valid for **30 days**.
- **Each send is capped at ~7 MB total.** The whole request (subject, body, and all attachment bytes) arrives base64-encoded in a single API Gateway request body, so the practical ceiling is ~7 MB decoded — well under API Gateway's 10 MB limit.

**Not yet shipped:** sending **truly large files (> 10 MB)** needs a direct-to-S3 upload path that bypasses the API Gateway body limit — that's tracked as [#34](https://github.com/Nan0416/FreeMail/issues/34) and is **not** available today. A download-token **revoke** endpoint is [#35](https://github.com/Nan0416/FreeMail/issues/35). Don't assume a size ceiling beyond the ~7 MB per-send budget.

## 9. Connect an agent

Agents send email through the MCP server — no browser, no cookies:

1. In the web app, open **API keys** and **create a key**. It's shown **once** (copy it then); it's stored hashed and can't be retrieved again. An API key authorizes an agent to **send and (when inbound is enabled) read the mailbox via the MCP server** — it does **not** grant key management or the REST mailbox-read routes, which require signing in to the web app with your password (the cookie session).
2. Point your MCP client at **`POST https://{apiDomain}/mcp`** with header **`x-api-key: fm_<your-key>`**.
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

The MCP server is stateless (Streamable HTTP), so no session setup is required. **`send_email`** is always available; when **inbound is enabled**, the read tools **`list_emails`**, **`get_email`**, and **`get_email_attachment_url`** are also registered, so agents can read received mail and mint short-lived presigned attachment download URLs. Received email is untrusted external content — the read tools return it marked as data (with a `trust` field and a delimited text frame), not as instructions to the agent. With inbound disabled, only `send_email` is offered.

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
