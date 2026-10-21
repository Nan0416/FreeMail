# Reconfiguring a live deployment

Follow this when stage 2 of [SKILL.md](SKILL.md) found `FreeMailStack` and the user means to change that deployment. Its rules still apply.

Do not run stages 3–5 as written. Their lookups find FreeMail's own resources — the `A`/`AAAA` records at its hostnames, its auth records and MX, its active receipt rule set, its SES identity, its zone's delegation — and treating those as conflicts would take the deployment apart.

## 1. Start from the config the stack runs

Use `freemail-config.json` if it exists, after checking it against the stack's outputs below. If it doesn't — the file is gitignored, so a fresh clone has none — rebuild it from the stack, read-only:

- From the `describe-stacks` outputs: `emailDomain` is `SesIdentityName`; `appDomain` is `WebAppUrl` and `apiDomain` is `ApiCustomDomainUrl`, each without `https://`.
- `zoneName` is `aws route53 get-hosted-zone --id <the HostedZoneId output>` → `HostedZone.Name` without the trailing dot. The mode is `create` when the stack has a `HostedZoneNameServers` output, else `import` — and only in `import` mode does the config carry `hostedZoneId` (the `HostedZoneId` output). A created zone's config has no ID: writing one fails validation, and "fixing" that by switching to `import` would make the deploy try to delete the zone.
- `sesIdentity.mode` is `create` when the stack has a `SesMailFromDomain` output, else `import`. In `create` mode, read the `TXT` record at the email domain: `aws route53 list-resource-record-sets --hosted-zone-id <the HostedZoneId output> --start-record-name <emailDomain> --start-record-type TXT --max-items 1`. Every value except `"v=spf1 include:amazonses.com ~all"` goes into `sesIdentity.extraTxtValues`, without its surrounding quotes. With none, leave it out. A config that leaves out values the stack publishes removes them from DNS on the next deploy.
- Inbound is on when `aws cloudformation list-stack-resources --stack-name FreeMailStack` lists an `AWS::SES::ReceiptRuleSet`. Write it on only after the user confirms it stays on — that confirmation is the MX acknowledgement.
- Custom attachment limits appear as `EMBED_MAX_BYTES` and `EMBED_TOTAL_BYTES` in the environment of the stack's REST handler (the `AWS::Lambda::Function` whose logical ID starts with `ApiRestHandler`): `aws lambda get-function-configuration --function-name <its PhysicalResourceId>`. Neither present → leave `attachments` out.

Show the user the config before changing anything.

## 2. Change only what the user asks for

Check only what changes, with the matching parts of stages 3–4: a new hostname's records, a new email domain's identity and records. An active receipt rule set is FreeMail's own when its `Metadata.Name` equals the `PhysicalResourceId` of the stack's `AWS::SES::ReceiptRuleSet`.

Warn before writing: changing a domain or the hosted zone replaces live resources, and switching `sesIdentity` from `create` to `import` deletes the identity FreeMail created and its DNS records, which stops sending.

## 3. Deploy

Write the file, run `npx --no freemail validate` until it passes, and continue with stage 6 of [SKILL.md](SKILL.md) (`CDKToolkit` already exists). In the diff summary, call out anything replaced or deleted before asking. Afterwards, stage 7 applies only where something changed — there is no first sign-in on a live deployment.
