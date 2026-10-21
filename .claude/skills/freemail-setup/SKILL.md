---
name: freemail-setup
description: Set up a FreeMail deployment end to end for the user — check their tools, AWS account and their domain's public DNS, ask a few plain-language questions, write and validate freemail-config.json, run cdk deploy with their go-ahead, and walk them through what follows (sign-in, DNS delegation, SES production access). Suits non-technical users. Also reconfigures an existing deployment. Use when the user wants to set up, deploy, configure or reconfigure FreeMail, or create or fix freemail-config.json.
---

# Set up FreeMail

You take the user from "I have a domain" to a working FreeMail deployment in their AWS account:

1. Check the tools
2. Check the AWS account
3. Look at the domain
4. Recommend a setup and ask
5. Write and validate the config
6. Deploy
7. After the deploy

Assume the user may not be technical. Look things up before asking. Ask about outcomes ("mail to you@example.com would arrive in FreeMail instead of Gmail"), not record types, and lead each question with your recommendation. If they are technical, match them.

[`docs/DEPLOY.md`](../../../docs/DEPLOY.md) is the reference for every fact below — read the linked section when you need more. The config schema is `parseFreeMailConfig` in `packages/shared/src/config.ts`.

## Rules

- **AWS is read-only, with two exceptions:** `cdk bootstrap` and `cdk deploy`, each run only after you have said what it will do and the user has said yes in this conversation. Never create, change or delete DNS records, SES identities, receipt rule sets or stacks any other way; never run `cdk destroy`; never register a domain.
- **No guessed values.** Every value comes from the user's answers or from command output. A hosted zone ID is copied from `list-hosted-zones`, never typed from memory.
- **The MX acknowledgement is the user's.** Set `inbound.confirmInboundMx` to `true` only after the user has said yes to pointing the domain's MX record at Amazon SES in this conversation.
- **The web app password is the user's.** Never choose it, type it, or sign in for them.
- **An existing config is not yours to overwrite.** If `freemail-config.json` exists, show it before anything else and ask whether to replace it.
- Pass `--profile <profile>` and `--region us-east-1` on every AWS command. FreeMail only deploys to `us-east-1`.
- Run the CLI as **`npx --no freemail …`**. `--no` keeps npx from downloading an unrelated `freemail` package from the npm registry when the repo's own CLI isn't installed.

## 1. Check the tools

- `node --version` — needs 20.19 or later, or 22.12 or later (the repo pins 22 in `.nvmrc`).
- `aws --version` — if it's missing, offer to install it (macOS: `brew install awscli`; otherwise [AWS's installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)). Install only on the user's yes.
- `dig` — for the DNS checks. It ships with macOS and most Linux; on Windows use `Resolve-DnsName`.
- `packages/cli/dist/index.js` and `packages/web/dist/index.html` must exist. If either doesn't, run `npm install && npm run build` at the repo root: without the web build, the deploy ships a placeholder page instead of the app.

## 2. Check the AWS account

`aws configure list-profiles`:

- **No profiles** — this machine has no AWS access set up. Ask whether they have an AWS account.
  - No account: they create one at https://aws.amazon.com (it asks for a payment card). Stop until they have one.
  - An account: they connect this machine to it. If they sign in through a portal URL like `https://<name>.awsapps.com/start`, that's `aws configure sso`; otherwise access keys with `aws configure`. Both are interactive, so ask them to run it (in Claude Code: `! aws configure sso`). The identity needs permission to create everything FreeMail deploys — on a personal account, administrator access is the simple choice.
- **One profile** — propose it.
- **Several** — run `aws sts get-caller-identity --profile <p>` for each, show the account IDs, and ask which one.

Then, with the chosen profile:

- `aws sts get-caller-identity` — tell the user the account ID. If the session has expired, ask them to run `aws sso login --profile <profile>` (in Claude Code: `! aws sso login --profile <profile>`) and retry.
- `aws cloudformation describe-stacks --stack-name FreeMailStack` — if it exists, this account already runs FreeMail, and a deploy **updates that deployment in place** (the stack is always `FreeMailStack`; one account holds one FreeMail). Show its `WebAppUrl` output and ask whether they mean to change it or meant another account. To change it, follow [reconfigure.md](reconfigure.md) instead of stages 3–5.
- `aws cloudformation describe-stacks --stack-name CDKToolkit` — missing means the account isn't bootstrapped for CDK yet; stage 6 does it.
- `aws sesv2 get-account` — `ProductionAccessEnabled: false` means the account is in the SES sandbox and can only send to verified addresses (stage 7).
- `aws ses describe-active-receipt-rule-set` — an active rule set means FreeMail cannot receive mail in this account: SES allows one active set per region, and FreeMail won't replace another one (stage 4).

## 3. Look at the domain

Ask which domain they want to use — one they own, such as `example.com`. If they don't own one, they register one first (through Route53 or any registrar; you don't buy it). Stop until they have.

Then look, without asking anything else. `<domain>` is the domain they named.

**Public DNS** — what the internet sees:

| Check                                                                        | What it tells you                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dig +short NS <domain>`                                                     | Who serves its DNS: `awsdns` names are Route53, `cloudflare.com` names are Cloudflare; name any other provider that's obvious from the hostnames. Empty means it isn't registered or doesn't resolve — tell the user and stop. |
| `dig +short MX <domain>`                                                     | Whether it already receives mail, and where (`google.com` → Google Workspace, `outlook.com` → Microsoft 365, …).                                                                                                               |
| `dig +short TXT <domain>`, `dig +short TXT _dmarc.<domain>`                  | Existing SPF (`v=spf1 …`), site-verification records, DMARC.                                                                                                                                                                   |
| `dig +short A app.<domain>`, `dig +short CNAME app.<domain>`, same for `api` | Whether the default hostnames are already in use.                                                                                                                                                                              |

**The AWS account:**

- `aws route53 list-hosted-zones` — the public zones (`Config.PrivateZone` false) for `<domain>` or a subdomain of it. For each, `aws route53 get-hosted-zone --id <id>` → `DelegationSet.NameServers`. A zone is **live** only when those match the public NS for its name (compare as sets, ignoring case and trailing dots; for a subdomain zone, `dig +short NS <subdomain>`). A zone that doesn't match is not what the internet sees: records FreeMail wrote there would never resolve, and the deploy would hang on certificate validation.
- `aws route53domains list-domains` — whether the domain was registered through AWS in this account (then its name servers are set in the Route53 console). An access error only means you can't tell.

## 4. Recommend a setup and ask

From what you found, pick a setup, explain it in a few sentences, and ask the user to confirm it or choose another.

**Where FreeMail's DNS lives** (`hostedZone`):

- **A live Route53 zone in this account serves the domain** → import it: `{ "mode": "import", "zoneName": "<Name without the trailing dot>", "hostedZoneId": "<Id without /hostedzone/>" }`. If two zones have that name, use the live one.
- **The domain's DNS is elsewhere** (the registrar, Cloudflare, another AWS account) → FreeMail needs a Route53 zone it can write to. Recommend a **subdomain zone** such as `mail.<domain>`: `{ "mode": "create", "zoneName": "mail.<domain>" }`. The user adds four `NS` records for `mail` at their current DNS provider (you give the exact values in stage 6), and nothing else about their domain changes. Moving the whole domain to Route53 instead means recreating every record it has first, which can't be listed from outside — suggest that only for a domain with nothing on it.
- **Nothing is on the domain yet** (no MX, no website) → a zone for the domain itself is fine: `{ "mode": "create", "zoneName": "<domain>" }`. The user then sets its name servers at the registrar.

**The email domain** — the part of addresses after the `@`. Use the zone's apex unless one of these holds, in which case use a subdomain such as `mail.<domain>`:

- the apex already receives mail and the user wants FreeMail to receive mail too;
- the apex has `TXT` records (SPF, verification) and FreeMail would create the identity (below) — its SPF record can't be added beside them.

**The web app and API hostnames** — `app.<zone>` and `api.<zone>` unless they're taken. All three domains must be in the zone, and the two hostnames must differ.

**Receiving mail.** Ask: "Should FreeMail also receive email at `<email domain>`, or only send?" If receive:

- With an active receipt rule set (stage 2), it can't in this account — explain, and offer send-only or another account.
- If the email domain has an `MX` today, say in plain words where its mail goes now and that it would stop arriving there. Recommend a subdomain if that mail matters.
- Then ask the acknowledgement on its own: "Point the MX record for `<email domain>` at Amazon SES?" Only a yes gives `"inbound": { "enabled": true, "confirmInboundMx": true }`. Otherwise write `{ "enabled": false, "confirmInboundMx": false }`.

**The SES identity** — look it up, ask only if it's ambiguous. `aws sesv2 get-email-identity --email-identity <email domain>`:

- `NotFoundException` → `"sesIdentity": { "mode": "create" }`. FreeMail creates the identity and its DKIM, SPF, MAIL FROM and DMARC records.
- Found, `VerifiedForSendingStatus: true` → `{ "mode": "import" }`. It's already set up for SES; creating it again would fail the deploy. Its auth records stay the user's to maintain ([DEPLOY.md §6b](../../../docs/DEPLOY.md#6b-using-an-existing-ses-identity-import-mode)).
- Found but not verified → explain and ask: `create` fails the deploy because the identity exists; `import` deploys, but sending fails until the identity verifies.

**Records already in an imported zone.** Run `aws route53 list-resource-record-sets --hosted-zone-id <id>` once. FreeMail creates these records, and the deploy fails ("already exists") if the zone already has one at the same name and type — or a `CNAME` at the same name, which blocks every other type there:

| FreeMail creates                                                                                     | When                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------- |
| `A` and `AAAA` at the web app and API hostnames                                                      | always                    |
| `TXT` at the email domain, `MX` + `TXT` at `bounce.<email domain>`, `TXT` at `_dmarc.<email domain>` | `sesIdentity` is `create` |
| `MX` at the email domain                                                                             | inbound is enabled        |

For a taken hostname, offer another. For a `TXT` at the email domain or `_dmarc`, the existing record usually serves another mail or verification setup, and FreeMail's record would be the only one left at that name — so recommend an email subdomain, and removing the record only if the user confirms nothing depends on it.

## 5. Write and validate the config

Write `freemail-config.json` at the repo root in this shape. Leave out `attachments` unless the user asked to change the embed limits ([DEPLOY.md §8](../../../docs/DEPLOY.md#8-attachments)).

```json
{
  "region": "us-east-1",
  "hostedZone": {
    "mode": "import",
    "zoneName": "example.com",
    "hostedZoneId": "Z0123456789ABCDEFGHIJ"
  },
  "emailDomain": "example.com",
  "appDomain": "app.example.com",
  "apiDomain": "api.example.com",
  "sesIdentity": { "mode": "create" },
  "inbound": { "enabled": false, "confirmInboundMx": false }
}
```

Run `npx --no freemail validate`. It checks the repo-root file through the loader `cdk deploy` uses and lists every problem at once: fix them all and rerun until it reports the file valid. It checks the file only, so stages 2–4 are what catch problems in the account.

## 6. Deploy

Run these from `packages/infra`.

1. **Bootstrap, if stage 2 found no `CDKToolkit`.** Say that it creates a small CDK staging stack, once per account and region. On a yes: `AWS_PROFILE=<profile> npx cdk bootstrap aws://<account>/us-east-1`.
2. **Show what the deploy will do.** `AWS_PROFILE=<profile> npx cdk diff`, then summarize it in plain words: what gets created, and for an existing stack what changes — name every replacement and deletion. Mention the IAM changes it lists, and that AWS bills the account for what FreeMail uses.
3. **Deploy on a yes.** Ask "Deploy now?", and only on a yes run `AWS_PROFILE=<profile> npx cdk deploy --require-approval never`. The user's yes after seeing the diff is the approval: CDK's own prompt for IAM changes can't be answered from a non-interactive shell. If your environment won't run it, give the user the command to run themselves (in Claude Code: `! cd packages/infra && AWS_PROFILE=<profile> npx cdk deploy --require-approval never`). A first deploy takes a while — CloudFront and certificate validation are slow — so run it where a command timeout can't cut it off (in Claude Code, as a background command) and keep the user posted.
4. **A created zone must be delegated during the deploy.** The deploy waits on certificate validation until the new zone resolves publicly ([DEPLOY.md §6](../../../docs/DEPLOY.md#6-custom-domains-required)). As soon as the zone exists — `aws route53 list-hosted-zones-by-name --dns-name <zone>` lists it first, with that exact name — get its name servers (`aws route53 get-hosted-zone --id <id>` → `DelegationSet.NameServers`) and tell the user exactly what to set: for a subdomain zone, four `NS` records named after the subdomain at their DNS provider; for a whole domain, those name servers at the registrar. Check `dig +short NS <zone>` until it shows them. The deploy then carries on by itself.
5. **If it fails,** read the error, find it in [DEPLOY.md §10](../../../docs/DEPLOY.md#10-troubleshooting), explain it in plain words, fix the cause, and ask before deploying again.

## 7. After the deploy

Read the outputs with `aws cloudformation describe-stacks --stack-name FreeMailStack`.

1. **Sign in now.** Tell the user to open `WebAppUrl` and sign in themselves, right away. On a new deployment the first password entered becomes the account password, and until someone signs in, anyone with the URL could claim it. There is no reset flow, so they should choose it carefully ([DEPLOY.md §3](../../../docs/DEPLOY.md#after-deploying)).
2. **Sending.** `aws sesv2 get-email-identity --email-identity <email domain>` → `VerifiedForSendingStatus`. A newly created identity can take a while to verify; SES keeps retrying by itself. If the account is in the sandbox, it can only send to verified addresses until AWS grants production access, which the user requests from the SES console (the `SesProductionAccessNote` output links to it; [DEPLOY.md §4](../../../docs/DEPLOY.md#4-ses-production-access-sandbox-exit)). Offer to draft the request: what they send and to whom, expected volume, and how bounces and complaints are handled (FreeMail tracks both and uses SES suppression).
3. **Check the API.** Run probes 1–3 of [`docs/CORS-VERIFICATION.md`](../../../docs/CORS-VERIFICATION.md) with `APP` and `API` set from the `WebAppUrl` and `ApiCustomDomainUrl` outputs, and report each pass or fail. They need no credentials; probes 4–6 need the user's access key or browser.
4. **Try it.** Suggest sending a test message from the web app (in the sandbox, only to a verified address) and, if inbound is on, emailing an address at the email domain from their personal account.
5. **Connect an agent,** if they want one: the web app's **MCP server** page creates the access key and shows a ready-made `.mcp.json` ([DEPLOY.md §9](../../../docs/DEPLOY.md#9-connect-an-agent)). The key is shown once, to the user.

Finish with a short summary: the app's URL, the email domain, and anything still pending (delegation, identity verification, production access).
