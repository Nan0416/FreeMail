# FreeMail

Self-hosted, single-tenant, open-source email for **agents and humans**, built on AWS SES.

Deploy it into **your own AWS account** and you get:

- a **web app** to send and (optionally) read email under your own domain,
- an **MCP server** so your agents can send email with a `send_email` tool, and
- effectively **unlimited addresses** on your domain — one deployment, one owner, your data.

One `cdk deploy` stands the whole thing up. See [`DESIGN.md`](./DESIGN.md) for the architecture rationale and firmed decisions, and [`docs/DEPLOY.md`](./docs/DEPLOY.md) for the full deploy walkthrough.

## Architecture

```mermaid
flowchart TB
    subgraph User["Your users"]
        Browser["Human · web browser"]
        Agent["Agent · MCP client"]
    end

    subgraph AWS["Your AWS account · us-east-1"]
        CF["CloudFront distribution<br/>(SPA only · appDomain)"]
        S3web["S3 · web bucket<br/>(React SPA)"]
        API["API Gateway · HTTP API<br/>(apiDomain · locked credentialed CORS)"]
        Authz["Lambda authorizer<br/>(cookie access token OR x-api-key)"]
        Rest["REST handler Lambda"]
        Mcp["MCP handler Lambda<br/>(POST /mcp · send_email)"]
        SES["Amazon SES<br/>(send + optional inbound)"]
        DDB["DynamoDB<br/>(auth · api keys · emails · download tokens)"]
        S3mail["S3 · mail bucket<br/>(inbound MIME · attachments)"]
        Parse["Inbound parser Lambda<br/>(optional)"]
    end

    Browser -->|"HTTPS · loads the SPA"| CF
    CF --> S3web
    Browser -->|"cross-origin fetch<br/>(httpOnly cookies · credentials: include)"| API
    Agent -->|"x-api-key (no Origin, no CORS)"| API

    API --> Authz
    API --> Rest
    API --> Mcp
    Rest --> SES
    Rest --> DDB
    Rest --> S3mail
    Mcp --> SES
    Mcp --> DDB

    SES -.->|"inbound receipt (optional)"| S3mail
    S3mail -.->|"ObjectCreated"| Parse
    Parse -.-> DDB
```

**How it fits together.** The React SPA is served from a private S3 bucket via CloudFront at your `appDomain`; the HTTP API lives at your `apiDomain`. **Both domains are required** — the browser calls the API cross-origin, so there is no working deployment without them.

The session rides in `HttpOnly; Secure; SameSite=Strict` cookies (`__Host-` prefixed, so they are host-locked to the api domain) with **no token in web storage**. Cross-origin access is defended in three coupled layers: `SameSite=Strict` blocks a foreign site outright; the API allows exactly **one** origin — your `appDomain` — with credentials, never a wildcard and never a reflected origin; and every state-changing route requires `Content-Type: application/json`, which forces a browser preflight that the origin allowlist then refuses. That third layer is what stops a _same-site sibling_ (`evil.example.com`), against which `SameSite=Strict` does nothing.

Agents skip the browser entirely and call the HTTP API directly with an `x-api-key` header — they send no `Origin`, so CORS never applies to them. A single Lambda authorizer accepts either credential and remains the only authorization boundary; CORS governs what a browser may _read_, never whether a request is allowed. Sending goes through Amazon SES; metadata and hashed secrets live in DynamoDB; raw inbound mail and attachments live in S3. Inbound is **off by default** — when enabled, SES writes received mail to S3 and a parser Lambda indexes it.

## Capabilities and limitations

| Area             | Shipped                                                                                                                                                                                          | Not yet (roadmap)                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Send**         | REST `POST /emails` and MCP `send_email`, from any address under your domain                                                                                                                     | —                                                                                     |
| **Agent access** | MCP `send_email` + read tools `list_emails` / `get_email` / `get_email_attachment_url` (reads available when inbound is enabled), via `x-api-key`                                                | —                                                                                     |
| **Read**         | Web inbox + reader (sandboxed HTML render), attachment download — **when inbound is enabled**                                                                                                    | —                                                                                     |
| **Inbound**      | Optional SES receipt → S3 → parse → index                                                                                                                                                        | —                                                                                     |
| **Attachments**  | Uploaded **straight to S3** (presigned PUT), up to **100 MB each**; files over 3 MB (or past 10 MB embedded per message) become **token-download links** (`/d/{token}`, 30-day expiry)           | Download-token revoke endpoint — [#35](https://github.com/Nan0416/FreeMail/issues/35) |
| **Auth**         | Single password (web) via httpOnly cookies; API keys (agents) authorize **MCP send + read** (reads when inbound is enabled). REST mailbox reads and key management still need the cookie session | —                                                                                     |
| **Region**       | `us-east-1` only (inbound SES + CloudFront ACM both require it)                                                                                                                                  | Other regions are unsupported                                                         |

## Monorepo layout

| Package            | Purpose                                                 |
| ------------------ | ------------------------------------------------------- |
| `packages/shared`  | Shared TypeScript types, config schema, utilities       |
| `packages/service` | Lambda handlers — REST API + MCP server                 |
| `packages/web`     | React single-page app (login, compose, inbox, key mgmt) |
| `packages/infra`   | AWS CDK app (the single `FreeMailStack`)                |
| `packages/cli`     | `freemail init` deploy-configuration CLI                |

## Prerequisites

- **Node.js 22** (see [`.nvmrc`](./.nvmrc); Node ≥ 20.19 also works)
- An **AWS account** with credentials configured, and **region `us-east-1`** (the only supported region)
- A **domain** you control, with a Route53 hosted zone (existing, or one FreeMail creates for you)
- **Two hostnames under that zone** — one for the web app (e.g. `app.example.com`) and one for the API (e.g. `api.example.com`). Both are **required**: the browser calls the API cross-origin, so neither has a usable default. `freemail init` prompts for them.
- The hosted zone **delegated at your registrar before you deploy**. Both hostnames get DNS-validated ACM certificates, and that validation **blocks the CloudFormation deploy** until the records resolve publicly — an undelegated zone means the deploy hangs.

## Quickstart

```sh
git clone https://github.com/Nan0416/FreeMail.git
cd FreeMail
npm install
npm run build            # type-checks + compiles every package, incl. the web SPA

npx freemail init        # interactive prompts → writes freemail-config.json
                         # (or: cp freemail-config.template.json freemail-config.json)

cd packages/infra
npx cdk bootstrap        # first time per account/region
npx cdk deploy           # deploys FreeMailStack, reads ../../freemail-config.json
```

After the deploy:

1. Open the **`WebAppUrl`** from the stack outputs and **sign in**. On a fresh deployment the first password you enter **becomes** the account password (trust-on-first-use), so type it carefully and do it promptly — until you do, the account is unclaimed.
2. **Request [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)** — SES starts every account in _sandbox_ mode (verified recipients only). This is a one-time, **manual, per-AWS-account** step that cannot be automated.
3. To let agents send, create an **API key** in the web app (shown once) and hand it to your agent as `x-api-key`.

Full walkthrough — hosted-zone setup, custom domains, inbound, DNS records, and troubleshooting — is in **[`docs/DEPLOY.md`](./docs/DEPLOY.md)**.

## Agent / MCP example

FreeMail exposes a stateless MCP server at **`POST {api}/mcp`**, authenticated with the API key you created in the web app. It always offers **`send_email`** (and **`create_attachment_upload`** for files); when **inbound is enabled** it also offers the read tools **`list_emails`**, **`get_email`**, and **`get_email_attachment_url`** so agents can read received mail. (Inbound email is untrusted external content — the read tools flag it as data, not instructions.)

```jsonc
// MCP client config — point your agent at the FreeMail MCP endpoint.
{
  "mcpServers": {
    "freemail": {
      "url": "https://<your-api-endpoint>/mcp", // ApiEndpoint output, or your apiDomain
      "headers": { "x-api-key": "fm_<your-api-key>" },
    },
  },
}
```

```jsonc
// send_email requires: `from` (under your domain), at least one recipient
// across to/cc/bcc, and at least one body — text and/or html.
{
  "name": "send_email",
  "arguments": {
    "from": "assistant@yourdomain.com",
    "to": ["someone@example.com"],
    "subject": "Hello from my agent",
    "text": "Sent through FreeMail's MCP server.",
  },
}
```

> The MCP server currently offers **`send_email` only**. Reading email from an agent (`list_emails`/`get_email`) is roadmap ([#13](https://github.com/Nan0416/FreeMail/issues/13)); humans read in the web app.

## Development

```sh
npm run build         # tsc -b + web build
npm test              # vitest across all workspaces
npm run lint          # eslint
npm run format:check  # prettier --check (CI gate)
npm run format        # prettier --write
```

To work on the web app locally against your **deployed** API, run `npm run dev -w @freemail/web` (after `npm run build`). The dev server reads `freemail-config.json` and proxies `/api` to your `apiDomain`, so the browser only talks to `localhost` — no CORS change needed. The session cookies are `Secure`, which Chrome and Firefox accept on `http://localhost` (Safari does not). It is your live mailbox: what you send is sent.

CI (`.github/workflows/ci.yml`) runs `format:check` → `lint` → `build` → `test`. Per-package scripts work too, e.g. `npm run build -w @freemail/shared`.

## Contributing

Contributions are welcome. Fork the repo, create a feature branch, and open a pull request:

1. `npm install` then `npm run build` to confirm a clean baseline.
2. Keep the tree formatted and green: `npm run format`, `npm run lint`, `npm test`.
3. Open a PR against `main` describing the change; CI must pass.

## License

[MIT](./LICENSE) © 2026 Nan Qin.
