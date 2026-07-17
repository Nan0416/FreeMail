# FreeMail

Self-hosted, single-tenant, open-source email service for **agents and humans**, built on AWS SES. Deploy it into your own AWS account: a web app to read/send email plus an **MCP server** so your agents can send email — under your own domain, with effectively unlimited addresses.

See [`DESIGN.md`](./DESIGN.md) for the full architecture and firmed decisions.

## Monorepo layout

| Package            | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| `packages/shared`  | Shared TypeScript types and utilities            |
| `packages/service` | Lambda handlers — REST API + MCP server          |
| `packages/web`     | React single-page app (login, compose, key mgmt) |
| `packages/infra`   | AWS CDK app (stacks, constructs)                 |
| `packages/cli`     | `freemail init` deploy-configuration CLI         |

## Requirements

- Node.js `>= 20` (see [`.nvmrc`](./.nvmrc))
- npm workspaces (bundled with npm)
- An AWS account + credentials (for deploying); region **us-east-1**

## Getting started

```sh
npm install        # install all workspace dependencies
npm run build      # type-check + compile every package
npm test           # run the test suite across all packages
npm run lint       # eslint
npm run format     # prettier --write
```

Per-package scripts are also available, e.g. `npm run build -w @freemail/shared`.

## Deploying

```sh
npm run build                       # build the CLI + infra
node packages/cli/dist/index.js init  # answer the prompts → writes freemail.config.json

cd packages/infra
npx cdk bootstrap                   # first time per account/region
npx cdk deploy                      # reads ../../freemail.config.json
```

`freemail init` asks about your Route53 hosted zone (import or create), the email
domain, optional app/API domains, and whether to enable inbound email — inbound
requires explicitly acknowledging that it overrides the domain's MX record. The
answers are written to `freemail.config.json`, which the CDK app reads at synth.
See [`DESIGN.md § Deploy UX`](./DESIGN.md).

> **Note:** SES starts in sandbox mode. Sending to arbitrary recipients requires
> [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
> — a one-time manual request per AWS account.

> **Your data is retained on teardown.** The mail S3 buckets and DynamoDB tables
> use a `RETAIN` removal policy so `cdk destroy` never silently deletes your
> email. That means a destroy leaves those buckets and tables behind as orphaned
> resources — delete them by hand if you truly want them gone.
