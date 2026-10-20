---
name: freemail-init
description: Write this repo's freemail-config.json, the FreeMail deploy config, by asking the user a few questions and looking up the rest in their AWS account (read-only), then check it with `freemail validate`. The agent counterpart of the interactive `npx freemail init`. Use when the user wants to set up, configure or reconfigure a FreeMail deployment, or create or fix freemail-config.json.
---

# Write freemail-config.json

You produce one file, `freemail-config.json` at the repo root, which `cdk deploy` reads. Ask the user only what they alone can decide — the questions in steps 1, 2 and 4 — and look everything else up with read-only AWS CLI calls. You are done when `freemail validate` passes and you have handed off (step 6).

[`docs/DEPLOY.md`](../../../docs/DEPLOY.md) explains every field; the schema the file must satisfy is `parseFreeMailConfig` in `packages/shared/src/config.ts`.

## Rules

- **Read-only AWS.** Only `get-*`, `list-*` and `describe-*` calls. Never create, change or delete DNS records, SES identities, receipt rule sets or stacks, and never run `cdk bootstrap` or `cdk deploy` — deploying is the user's step.
- **No guessed values.** Every value comes from the user's answers or from AWS output. A hosted zone ID is copied from `list-hosted-zones`, never typed from memory.
- **The MX acknowledgement is the user's.** Set `inbound.confirmInboundMx` to `true` only after the user has said yes to pointing the domain's MX record at SES in this conversation. Never decide it for them.
- **An existing config is not yours to overwrite.** If `freemail-config.json` exists, show it before anything else and ask whether to replace it.
- Pass `--profile <profile>` (from step 1) and `--region us-east-1` on every AWS command. FreeMail only deploys to `us-east-1`.
- Run the CLI as **`npx --no freemail …`**. `--no` keeps npx from downloading an unrelated `freemail` package from the npm registry when the repo's own CLI isn't installed.

Before step 1, check that `packages/cli/dist/index.js` exists. If it doesn't, run `npm install && npm run build` from the repo root (the deploy needs that build anyway).

## 1. Which AWS account

Ask which AWS profile they will deploy with (`aws configure list-profiles` gives the choices). Then:

- `aws sts get-caller-identity` — tell the user the account ID. If the session has expired, ask them to run `aws sso login --profile <profile>` (in Claude Code: `! aws sso login --profile <profile>`) and retry.
- `aws cloudformation describe-stacks --stack-name FreeMailStack` — if the stack exists, this account already has a FreeMail deployment, and deploying this config **updates that deployment in place** (the stack is always `FreeMailStack`; one account holds one FreeMail). Show its `WebAppUrl` output and ask whether they mean to reconfigure it or meant another account. To reconfigure it, follow [Reconfiguring a live deployment](#reconfiguring-a-live-deployment) instead of steps 2–4.
- `aws sesv2 get-account` — note `ProductionAccessEnabled`. If it is `false`, the account is in the SES sandbox; you will mention it at hand-off.

## 2. Which domains

`aws route53 list-hosted-zones` — keep the public zones (`Config.PrivateZone` false). Then ask, showing those zones:

- the **email domain** — what addresses look like after the `@`: a zone apex (`example.com`) or a subdomain of it (`mail.example.com`);
- the **web app** and **API** hostnames — offer `app.<zone>` and `api.<zone>` as defaults. They must differ, and all three domains must be in one hosted zone.

Resolve the hosted zone from the answers:

- **Import** the deepest public zone that contains all three domains: `"hostedZone": { "mode": "import", "zoneName": "<Name without the trailing dot>", "hostedZoneId": "<Id without /hostedzone/>" }`. If two public zones have that name, only one is live: compare `dig +short NS <zone>` with each zone's `aws route53 get-hosted-zone --id <id>` → `DelegationSet.NameServers`, and use the one that matches.
- **Create** when no zone contains all three: `{ "mode": "create", "zoneName": "<domain>" }`, where `<domain>` is the domain the user wants FreeMail's zone to serve. Before going on, tell the user what it takes and get their OK:
  - The new zone must be delegated before the first deploy can finish — certificate validation hangs until it is ([DEPLOY.md §6](../../../docs/DEPLOY.md#6-custom-domains-required)). For a registered domain, they set the zone's name servers at the registrar; for a subdomain, they add NS records for it in the parent domain's DNS.
  - If the domain's DNS is already served somewhere, delegating moves all of it to the new, empty zone: its website and mail stop resolving unless those records are recreated first. For a domain in use, suggest a subdomain zone instead.

For an imported zone, run `aws route53 list-resource-record-sets --hosted-zone-id <id>` once and keep the listing: steps 3 and 4 use it too. FreeMail creates these records, and the deploy fails ("already exists") if the zone already has one at the same name and type — or a `CNAME` at the same name, which blocks every other type there:

| FreeMail creates                                                                                     | When                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------- |
| `A` and `AAAA` at the web app and API hostnames                                                      | always                    |
| `TXT` at the email domain, `MX` + `TXT` at `bounce.<email domain>`, `TXT` at `_dmarc.<email domain>` | `sesIdentity` is `create` |
| `MX` at the email domain                                                                             | inbound is enabled        |

Report each conflict and the records involved. For a hostname, offer a different one. For a `TXT` at the email domain or `_dmarc`, the existing record usually serves another mail or verification setup, and FreeMail's record would be the only one left at that name — so recommend a dedicated email subdomain (`mail.<zone>`) first, and removing the record only if the user confirms nothing depends on it.

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

Run `npx --no freemail validate`. It checks the repo-root file through the loader `cdk deploy` uses and lists every problem at once: fix them all and rerun until it reports the file valid. It checks the file only and makes no AWS calls, so steps 1–4 are what catch problems in the account.

## 6. Hand off

Tell the user the account, each value and whether they chose it or you looked it up, and every warning raised along the way (zone to delegate, record conflicts they still need to clear, unverified identity, mail routing being replaced, SES sandbox). Then give the next steps — do not run them:

```sh
cd packages/infra
AWS_PROFILE=<profile> npx cdk bootstrap   # first deploy in this account/region only
AWS_PROFILE=<profile> npx cdk deploy
```

Right after the deploy they should open the `WebAppUrl` output and sign in: on a new deployment the first password entered becomes the account password. If the account is in the SES sandbox, they must also request production access ([DEPLOY.md §4](../../../docs/DEPLOY.md#4-ses-production-access-sandbox-exit)).

## Reconfiguring a live deployment

When the user means to change the `FreeMailStack` that step 1 found, do not run steps 2–4 as written. Their lookups find FreeMail's own resources — the `A`/`AAAA` records at its hostnames, its auth records and MX, its active receipt rule set, its SES identity — and treating those as conflicts would take the deployment apart.

1. **Start from the config the stack runs.** Use `freemail-config.json` if it exists, after checking it against the stack's outputs below. If it doesn't — the file is gitignored, so a fresh clone has none — rebuild it from the stack, read-only:
   - From the `describe-stacks` outputs: `emailDomain` is `SesIdentityName`; `appDomain` is `WebAppUrl` and `apiDomain` is `ApiCustomDomainUrl`, each without `https://`.
   - `hostedZoneId` is the `HostedZoneId` output; `zoneName` is `aws route53 get-hosted-zone --id <it>` → `HostedZone.Name` without the trailing dot. The mode is `create` when the stack has a `HostedZoneNameServers` output, else `import`.
   - `sesIdentity.mode` is `create` when the stack has a `SesMailFromDomain` output, else `import`.
   - Inbound is on when `aws cloudformation list-stack-resources --stack-name FreeMailStack` lists an `AWS::SES::ReceiptRuleSet`. Write it on only after the user confirms it stays on — that confirmation is the MX acknowledgement.
   - Custom attachment limits appear as `EMBED_MAX_BYTES` and `EMBED_TOTAL_BYTES` in the environment of the stack's REST handler (the `AWS::Lambda::Function` whose logical ID starts with `ApiRestHandler`): `aws lambda get-function-configuration --function-name <its PhysicalResourceId>`. Neither present → leave `attachments` out.

   Show the user the rebuilt config before changing anything.

2. **Change only what the user asks for**, and check only what changes against steps 2–4: a new hostname's records, a new email domain's identity and records. An active receipt rule set is FreeMail's own when its `Metadata.Name` equals the `PhysicalResourceId` of the stack's `AWS::SES::ReceiptRuleSet`.
3. **Warn before writing.** Changing a domain or the hosted zone replaces live resources, and switching `sesIdentity` from `create` to `import` deletes the identity FreeMail created and its DNS records, which stops sending.
