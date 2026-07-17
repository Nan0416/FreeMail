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

This is the Phase 1 **scaffolding** only — no AWS or business logic yet.

## Requirements

- Node.js `>= 20` (see [`.nvmrc`](./.nvmrc))
- npm workspaces (bundled with npm)

## Getting started

```sh
npm install        # install all workspace dependencies
npm run build      # type-check + compile every package
npm test           # run the test suite across all packages
npm run lint       # eslint
npm run format     # prettier --write
```

Per-package scripts are also available, e.g. `npm run build -w @freemail/shared`.
