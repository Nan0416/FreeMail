---
name: freemail-init
description: Write this repo's freemail-config.json, the FreeMail deploy config, by asking the user a few questions and looking up the rest in their AWS account (read-only), then check it with `npx freemail validate`. The agent counterpart of the interactive `npx freemail init`. Use when the user wants to set up, configure or reconfigure a FreeMail deployment, or create or fix freemail-config.json.
---

# Write freemail-config.json

You produce one file, `freemail-config.json` at the repo root, which `cdk deploy` reads. Ask the user only what they alone can decide — the questions in steps 1, 2 and 4 — and look everything else up with read-only AWS CLI calls. You are done when `npx freemail validate` passes and you have handed off (step 6).

[`docs/DEPLOY.md`](../../../docs/DEPLOY.md) explains every field; the schema the file must satisfy is `parseFreeMailConfig` in `packages/shared/src/config.ts`.

## Rules

- **Read-only AWS.** Only `get-*`, `list-*` and `describe-*` calls. Never create, change or delete DNS records, SES identities, receipt rule sets or stacks, and never run `cdk bootstrap` or `cdk deploy` — deploying is the user's step.
- **No guessed values.** Every value comes from the user's answers or from AWS output. A hosted zone ID is copied from `list-hosted-zones`, never typed from memory.
- **The MX acknowledgement is the user's.** Set `inbound.confirmInboundMx` to `true` only after the user has said yes to replacing the domain's MX record in this conversation (step 4). Never decide it for them.
- **An existing config is not yours to overwrite.** If `freemail-config.json` exists, show it before anything else and ask whether to replace it.
- Pass `--profile <profile>` (from step 1) and `--region us-east-1` on every AWS command. FreeMail only deploys to `us-east-1`.

Before step 1: `npx freemail version` must print a version. If it prints nothing or fails, run `npm install && npm run build` from the repo root (the deploy needs that build anyway).

## 1. Which AWS account

Ask which AWS profile they will deploy with (`aws configure list-profiles` gives the choices). Then:

- `aws sts get-caller-identity` — tell the user the account ID. If the session has expired, ask them to run `aws sso login --profile <profile>` (in Claude Code: `! aws sso login --profile <profile>`) and retry.
- `aws cloudformation describe-stacks --stack-name FreeMailStack` — if the stack exists, this account already has a FreeMail deployment, and deploying this config **updates that deployment in place** (the stack is always `FreeMailStack`; one account holds one FreeMail). Show its `WebAppUrl` output and ask whether they mean to reconfigure it or meant another account. If they are reconfiguring, see [Reconfiguring a live deployment](#reconfiguring-a-live-deployment).
- `aws sesv2 get-account` — note `ProductionAccessEnabled`. If it is `false`, the account is in the SES sandbox; you will mention it at hand-off.

## 2. Which domains

`aws route53 list-hosted-zones` — keep the public zones (`Config.PrivateZone` false). Then ask, showing those zones:

- the **email domain** — what addresses look like after the `@`: a zone apex (`example.com`) or a subdomain of it (`mail.example.com`);
- the **web app** and **API** hostnames — offer `app.<zone>` and `api.<zone>` as defaults. They must differ, and all three domains must be in the same hosted zone.

Resolve the hosted zone from the answer:

- A public zone whose name is the email domain or its nearest parent → `"hostedZone": { "mode": "import", "zoneName": "<Name without the trailing dot>", "hostedZoneId": "<Id without /hostedzone/>" }`.
- No such zone → `{ "mode": "create", "zoneName": "<the domain to create a zone for>" }`. Tell the user what that means before going on: they must set the new zone's name servers at their domain registrar, and the first deploy hangs on certificate validation until they do ([DEPLOY.md §6](../../../docs/DEPLOY.md#6-custom-domains-required)). Get their OK.

For an imported zone, run `aws route53 list-resource-record-sets --hosted-zone-id <id>` once and keep the listing: steps 3 and 4 use it too. A record already at a name and type FreeMail creates makes the deploy fail ("already exists"), so check these:

| FreeMail creates                                                                                     | When                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------- |
| `A` and `AAAA` at the web app and API hostnames                                                      | always                    |
| `TXT` at the email domain, `MX` + `TXT` at `bounce.<email domain>`, `TXT` at `_dmarc.<email domain>` | `sesIdentity` is `create` |
| `MX` at the email domain                                                                             | inbound is enabled        |

Report any conflict and let the user choose: a different hostname or subdomain, or removing the record themselves.

## 3. SES identity — look it up

`aws sesv2 get-email-identity --email-identity <email domain>`:

- `NotFoundException` → `"sesIdentity": { "mode": "create" }`. FreeMail creates the identity and its DKIM, SPF, MAIL FROM and DMARC records.
- Found, `VerifiedForSendingStatus: true` → `{ "mode": "import" }`. The domain is already set up for SES; creating it again would fail the deploy. Tell the user its auth records stay theirs to maintain ([DEPLOY.md §6b](../../../docs/DEPLOY.md#6b-using-an-existing-ses-identity-import-mode)).
- Found but not verified → explain the choice and ask: `create` fails the deploy because the identity exists; `import` deploys, but sending fails until the identity verifies.

## 4. Receive mail?

Ask whether FreeMail should receive mail at the email domain. Off is the default. If yes:

- Look for an `MX` at the email domain in the record listing. If one exists, show the user where that domain's mail goes today and say inbound replaces it — the record has to be removed before the deploy can create FreeMail's. If that mail matters, suggest a dedicated subdomain such as `mail.<zone>` and go back to step 2.
- `aws ses describe-active-receipt-rule-set` — if a rule set is active, inbound will fail the deploy: SES allows one active rule set per account and region, and FreeMail will not replace another one. The user must deactivate it, or deploy to another account.
- Then ask the acknowledgement on its own: "Point the MX record for `<email domain>` at Amazon SES?" Only a yes gives `"inbound": { "enabled": true, "confirmInboundMx": true }`. Otherwise write `{ "enabled": false, "confirmInboundMx": false }`.

## 5. Write and validate

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

Run `npx freemail validate` from the repo root. It loads the file the way `cdk deploy` does and lists every problem at once: fix them all and rerun until it reports the file valid. It checks the file only and makes no AWS calls, so steps 1–4 are what catch problems in the account.

## 6. Hand off

Tell the user the account, each value and whether they chose it or you looked it up, and every warning raised along the way (zone to delegate, record conflicts they still need to clear, unverified identity, mail routing being replaced, SES sandbox). Then give the next steps — do not run them:

```sh
cd packages/infra
AWS_PROFILE=<profile> npx cdk bootstrap   # first deploy in this account/region only
AWS_PROFILE=<profile> npx cdk deploy
```

Right after the deploy they should open the `WebAppUrl` output and sign in: on a new deployment the first password entered becomes the account password. If the account is in the SES sandbox, they must also request production access ([DEPLOY.md §4](../../../docs/DEPLOY.md#4-ses-production-access-sandbox-exit)).

## Reconfiguring a live deployment

When step 1 found `FreeMailStack`, many lookups find FreeMail's own resources, not conflicts: the A/AAAA records at its hostnames, its auth records, its MX, its active receipt rule set, and — if it created it — its SES identity. Start from the existing `freemail-config.json` and change only what the user asks to change. Warn them that changing a domain or the hosted zone replaces live resources, and that switching `sesIdentity` from `create` to `import` deletes the identity FreeMail created and its DNS records, which stops sending.
