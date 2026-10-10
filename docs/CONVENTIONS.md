# TypeScript Service Conventions

The structural conventions this repo settled on, written down so a new project can start
from them instead of rediscovering them. Nothing here is about business logic — it is about
where code goes, what things are named, and which shapes the tooling will and will not let
you write.

Most of this is adapted from an internal reference service (`conduit`). Where this repo
deliberately departs from it, the departure is marked **[deviation]** with the reason.

---

## Style rules at a glance

The code-shape rules, in one place. Each links to the section with the reasoning and the
edge cases; the tag says what catches a violation.

1. **Braces on every control-statement body** — `if` / `else` / `for` / `while` / `do`,
   even a single statement. _ESLint `curly`_ · §9
2. **No object destructuring** — not in declarations, parameters, `for…of` heads, or
   `catch`. Name the object and read its fields (`input.keyId`, `result.created`). Array
   destructuring is allowed; `packages/web/src/components/ui/**` is exempt. _ESLint
   `no-restricted-syntax`_ · §9
3. **Parameter names follow the layer** — DAO methods take `input`, service methods
   `request`, React components `props`. _Review_ · §9
4. **One DAO interface per table** — reads and writes together, no `XReadDao` split.
   _Review_ · §4
5. **DAO methods: one Input interface in, one Output interface out** — named
   `<Verb><Entity>Input` / `<Verb><Entity>Output`; `| null` is the only variation. No
   parameters → empty Input; nothing to report → empty Output; a list → an Output wrapping
   it; same shape as another type → `interface X extends Y {}`. A union is the only Output
   that may be a `type`. _Compiler + review_ · §4
6. **Service methods take one `<Method>ServiceRequest` named `request`** and return the
   full response shape; genuinely void stays `Promise<void>`. _Review_ · §5
7. **Interface and type-alias fields are `readonly`.** _ESLint `no-restricted-syntax`_ · §9
8. **`import type` for type-only imports; relative imports end in `.js`.** _Compiler_ · §9

---

## 1. Source layout

One folder per architectural role. **No domain folders** (`auth/`, `email/`, `inbound/`) —
a module's folder says what _kind_ of thing it is, not what feature it belongs to.

```
src/
  handlers/       Lambda entry points + their per-Lambda config + the app assembly
  routes/         HTTP route tables, one Endpoints class per domain surface
  middleware/     Cross-cutting request stages
  services/       Business logic
  facades/        Adapters over systems we do not own (SES, S3, secrets)
  data/           DAOs: one interface + one implementation per table
  dependencies/   Per-Lambda dependency factories
  utils/          Pure helpers, error types, logging, env parsing
  index.ts        Package barrel
```

**Why no domain folders.** A feature touches every layer, so domain folders guarantee that
adding one means editing five directories anyway — while making "what does the send path
actually talk to?" unanswerable without opening all of them. Role folders make the
dependency direction visible: `routes → services → {facades, data}`, never backwards.

**`services/` vs `facades/`.** A facade contains no business rules. It exists so a service
can depend on a small fakeable interface instead of an AWS SDK client. If it decides
something, it is a service; if it only translates a call, it is a facade.

---

## 2. Per-Lambda wiring

Every Lambda is a **triple**, named consistently:

```
handlers/<name>.ts                          entry point — nothing but wiring
handlers/<name>-config.ts                   its environment contract
dependencies/<name>-dependency-factory.ts   what it talks to
```

The entry point does one thing: build once, memoize, delegate.

```ts
let apigHandler: ApiGatewayHandler | undefined;

function buildHandler(): ApiGatewayHandler {
  if (apigHandler) {
    logger.debug('Reusing lambda instance.');
    return apigHandler;
  }
  logger.info('Creating new MCP handler instance.');
  const deps = new McpDependencyFactory(getMcpConfig()).build();
  // ... compose the Express app from middleware + endpoints ...
  apigHandler = toApiGatewayHandler(service.init());
  return apigHandler;
}
```

Both HTTP Lambdas memoize the same thing — the **serverless-express-wrapped Express app** —
so the cold-start cost (DynamoDB, S3, and SES clients) is paid once per execution
environment. What is deliberately NOT memoized is anything holding per-connection state: the
MCP server and its transport are rebuilt per request, for reasons `routes/mcp-endpoints.ts`
spells out.

**[deviation]** The reference service keeps its _main_ service's config at the package root
as `stage-config.ts`, and gives only its secondary Lambdas a `handlers/<name>-config.ts`.
Here the main service follows the same rule as every other Lambda —
`handlers/service-config.ts` — so there are four identical cases instead of three plus an
exception.

### Configs are per-Lambda, never shared

Each Lambda gets a **different** environment from the infrastructure, so one config type
cannot describe them all without being wrong for most. The REST handler has the auth and
API-key tables; the MCP handler has neither; the inbound parser has only a table and a
bucket. Validate each separately.

```ts
const ENV_SCHEMA = z.object({
  EMAILS_TABLE: envString(),
  MAIL_BUCKET: envString(),
});

export function getInboundConfig(env: NodeJS.ProcessEnv = process.env): InboundConfig {
  const parsed = parseEnv(ENV_SCHEMA, 'inbound handler', env);
  return { emailsTable: parsed.EMAILS_TABLE, mailBucket: parsed.MAIL_BUCKET };
}
```

Rules that matter:

- **Report every missing variable at once.** A deployment missing three variables should
  need one look at the logs, not three redeploys.
- **Empty string means absent.** An unset value can surface either way, and `""` is never a
  usable table name.
- **`process.env` appears in config files and nowhere else.** Everything downstream takes
  a typed config object. A dependency factory that still reaches for the environment has a
  hidden input.
- **Memoize.** The environment cannot change under a running Lambda.

---

## 3. Dependency factories

`build()` is **eager and synchronous**, layered clients → DAOs → facades → services, and
returns both the DAOs and the services.

```ts
build(): Dependencies {
  const doc = createDocumentClient();
  const s3 = new S3Client({});

  const authDao = new DdbAuthDao(doc, this.config.authTable);
  const emailsDao = new DdbEmailsDao(doc, this.config.emailsTable);
  // ...
  return { authDao, emailsDao, authService, emailService, /* ... */ };
}
```

- **One client of each kind per Lambda.** A client owns a connection pool; four DAOs each
  constructing their own quietly creates four. This is why DAOs _take_ a client rather than
  building one — and why the client parameter is required, not optional with a default.
- **No I/O in `build()`.** If a dependency needs I/O to construct (a signing key read from
  a table), inject a **provider** rather than the resolved value. That keeps construction
  free and keeps the I/O behind whatever request-level gates run first.
- **Expose the DAOs too**, not just the services — they are the useful seam for anything
  that needs storage without the policy on top.

---

## 4. Data layer (DAOs)

### File and type naming

```
data/<entity>-dao.ts        the interface + its Input/Output types
data/ddb-<entity>-dao.ts    the DynamoDB implementation
data/entities.ts            the key schema for every table
data/index.ts               barrel
```

### Method shape

**One interface per table.** Reads and writes live on the same DAO: there is no
`XReadDao`/`XWriteDao` split. A consumer that only reads still depends on the whole
interface, and its test fake stubs the methods it never calls. Constructor order is
`(client, tableName)`.

**Every method takes exactly one `<Verb><Entity>Input` interface and returns exactly one
`<Verb><Entity>Output` interface.** That holds even when there is nothing to pass or nothing
to report. The only variation allowed is `| null` on the Output, for a lookup that can miss.

```ts
export interface ApiKeysDao {
  createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyOutput>;
  getApiKey(input: GetApiKeyInput): Promise<GetApiKeyOutput | null>;
  listApiKeys(input: ListApiKeysInput): Promise<ListApiKeysOutput>;
  deleteApiKey(input: DeleteApiKeyInput): Promise<DeleteApiKeyOutput>;
}
```

| Situation                  | Write                                                      | Not                                       |
| -------------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| No parameters              | `interface ListApiKeysInput {}`, called with `{}`          | `listApiKeys()`                           |
| Nothing to report          | `interface DeleteApiKeyOutput {}`, implemented `return {}` | `Promise<void>`                           |
| A list                     | `interface ListApiKeysOutput { readonly apiKeys: [...] }`  | `Promise<ReadonlyArray<GetApiKeyOutput>>` |
| May be absent              | `Promise<GetApiKeyOutput \| null>`                         | `undefined`, or a `found` flag            |
| Same shape as another type | `interface GetLockoutOutput extends LockoutState {}`       | `type GetLockoutOutput = LockoutState`    |
| One of several shapes      | `type GetEmailOutput = SentRow \| InboundRow`              | —                                         |

An implementation names an unused empty Input `_input`. A union is the one place a `type`
alias stands in for an Output, because an interface cannot be a union.

Why the strictness:

- **No transpositions.** Even single-scalar methods take an object. Two same-typed positional
  arguments are a transposition waiting to happen.
- **Signatures grow in one place.** Adding a field to an existing Input or Output (a cursor
  on a list, a `created` flag on a write) changes no call site. Turning a bare array, a
  `void`, or a zero-argument method into one later touches every caller and every fake.
- **Nothing to second-guess.** Every method reads the same way, so a reviewer never has to
  ask whether a missing Input or Output was deliberate.

Empty interfaces need a lint exception: `eslint.config.mjs` relaxes `no-empty-object-type`
for `packages/service/src/data/**` only (see §9).

> **Sharp edge.** An empty interface accepts any non-null value, so `Promise<DeleteApiKeyOutput>`
> does not stop an implementation from returning `true`. The compiler only checks that
> _something_ comes back. Return a literal `{}`.

### Booleans that mean something get a named Output

A conditional write's success/failure is load-bearing — it _is_ the concurrency mechanism.
Wrap it so the meaning travels with the value:

```ts
export interface CreatePasswordHashOutput {
  /** False when a password was already enrolled — the conditional write did not run. */
  readonly created: boolean;
}
```

> **Sharp edge.** Converting `Promise<boolean>` → `Promise<{ created: boolean }>` silently
> breaks every `if (!result)` at the call site, because an object is always truthy. The
> compiler cannot see it. Grep every call site when you do this. It shipped two real bugs
> here — an accepted replayed refresh token and a broken idempotency check — both caught
> only by tests.

### Key schema lives in one module

`data/entities.ts` answers "how is this row addressed?" so a key is never spelled twice:

```ts
export const AuthEntity = {
  password: (): TableKey => ({ pk: 'auth', sk: 'password' }),
  refreshToken: (tokenHash: string): TableKey => ({ pk: 'refresh', sk: tokenHash }),
} as const;
```

**[deviation]** The reference service builds this on an ORM (ElectroDB). Here the raw
commands are kept, because the `ConditionExpression`s _are_ the concurrency safety —
first-writer-wins enrollment, atomic claim-and-consume, versioned compare-and-swap — and
each has a test pinning that exact semantics. `entities.ts` is the schema half of an entity
definition without the query builder on top.

### Interface, then implementation

The DAO is an interface so services depend on a seam, not on DynamoDB, and every branch is
unit-testable against an in-memory fake with no AWS involved.

---

## 5. Services

Business logic. Reaches storage and AWS only through injected DAOs and facades.

**Every public method takes a named `<Method>ServiceRequest`** — even for one parameter,
even for none — and the parameter is called `request`.

```ts
async login(request: LoginServiceRequest): Promise<LoginServiceResponse>;
async list(_request: ListApiKeysServiceRequest): Promise<ListApiKeysResponse>;
async revoke(request: RevokeApiKeyServiceRequest): Promise<void>;
```

Responses reuse the shared wire types where one exists (`ListApiKeysResponse`,
`SendEmailResponse`); otherwise define a local `<Method>ServiceResponse`.

- **Return the full response shape**, not a bare array — `{ keys: [...] }`, so the route
  does no hand-wrapping.
- **Genuinely void stays `Promise<void>`.** Inventing a field to have a Response type is
  worse than not having one. (DAOs are stricter and return an empty Output — see §4.)
- **Zero-input still takes a Request:** `type ListApiKeysServiceRequest = Record<string, never>`.
  (Not an empty interface — see §9.)

---

## 6. HTTP layer

One `Endpoints` class per domain surface. Router built in the constructor, `bind(app)`
mounts it, every handler wrapped in `try/catch { next(err) }`.

```ts
export class KeysEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(apiKeyService: ApiKeyService) {
    this.router = Router();
    this.router.post('/keys', requireJsonContentType, requireAccessScheme, async (req, res, next) => {
      try {
        res.status(201).json(await apiKeyService.create({ name: /* ... */ }));
      } catch (err) {
        next(err);
      }
    });
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}
```

- **Per-route guards over inline checks.** A route reads as its own precondition list.
- **Middleware order is a contract, not a preference.** Document it where the array is
  declared, and say what breaks if it changes.
- **Only parse what you accept.** Registering a body parser for a content type you
  deliberately reject elsewhere reopens the hole you closed.
- **Route patterns declared twice** (infrastructure `{id}` vs Express `:id`) cannot share a
  constant — so pin them with a test that drives every route and fails if one reaches the
  terminal 404.

---

## 7. Errors

One `utils/errors.ts`. The middleware error handler discriminates over all of them, so
scattering them across folders only lengthens its import list.

Two families, deliberately not merged under one base class:

- **Wire errors** carry the client-visible code _and_ the HTTP status. The service that
  knows why something failed decides the status; the handler only renders it.
- **Internal control-flow errors** never reach a client — they mark a failure as _handled_
  (log and succeed) versus _unhandled_ (propagate and retry).

The error handler is the only place a throw becomes a response. Anything unrecognized is
logged and flattened to a generic 500 — no internal message, stack, or stray field escapes.

---

## 8. Logging

`getLogger('<component>')`, level from `LOG_LEVEL`, uniform `<iso> <LEVEL> [<name>] <message>`.

**Never log the request.** Not the headers, not the `Cookie` header, not a token or key.
Session credentials live in httpOnly cookies precisely so page JS cannot read them; a log
line echoing a request puts a live session into CloudWatch. Pin it with a test.

The same applies to libraries: check whether a dependency's debug level dumps the raw event,
and set its log level explicitly rather than relying on a safe default.

---

## 9. What the tooling permits

Several conventions exist _because_ of these settings. Copy them together with the code
style, or the style will not typecheck.

**`tsconfig.base.json`** — `strict`, `noUnusedLocals`, `noUnusedParameters`,
`noFallthroughCasesInSwitch`, `noImplicitOverride`, `verbatimModuleSyntax`,
`module: NodeNext`, `composite`.

- ESM with `NodeNext` → **relative imports end in `.js`**, even from `.ts`.
- `verbatimModuleSyntax` → **`import type` is mandatory** for type-only imports.

**ESLint**

- All interface properties and type-alias object properties must be **`readonly`**
  (enforced by `no-restricted-syntax` selectors — no type-aware linting needed).
- `curly: ['error', 'all']` — every `if` / `else` / `for` / `while` / `do` body takes braces,
  even when it is a single statement.

  ```ts
  if (!record) {
    return null;
  }
  // never: if (!record) return null;
  ```

- **No object destructuring** (`no-restricted-syntax` → `ObjectPattern`). This covers
  declarations, parameters, `for…of` heads and `catch` clauses alike. Name the object and
  read its fields where you use them, so every use site shows where the value came from.

  ```ts
  async getApiKey(input: GetApiKeyInput) {          // not ({ keyId }: GetApiKeyInput)
    ... ApiKeyEntity.key(input.keyId) ...
  }
  const result = await dao.createApiKey(...);       // not const { created } = ...
  if (result.created) { ... }
  function Sidebar(props: SidebarProps) { ... props.view ... }
  ```

  Parameter names follow the layer: DAO methods take `input`, service methods `request`,
  React components `props`. Do not swap destructuring for alias lines
  (`const keyId = input.keyId;`); that is the same unpacking spelled out by hand. A local
  copy is fine only when it is genuinely needed: to keep a type narrowing inside a closure,
  to snapshot a value before it changes, or to apply a default once.

  Two things are allowed. Array destructuring (`const [open, setOpen] = useState(false)`)
  stays, because a tuple has no field names to preserve. `packages/web/src/components/ui/**`
  is exempt, because the shadcn CLI generates those files and they strip props with
  `({ className, ...props })`, an omit-and-spread that has no destructuring-free equivalent.

- `no-empty-object-type` (from the recommended set) **rejects `interface X {}`** everywhere
  except `packages/service/src/data/**`, where §4 requires empty Input/Output interfaces.
  Elsewhere, when you need "no fields", use `type X = Record<string, never>`; when you need
  "no return", use `Promise<void>`.
- `no-unused-vars` is configured with `argsIgnorePattern: '^_'` to **agree with
  `noUnusedParameters`**. Without this the compiler and the linter disagree, and a parameter
  that must exist but is deliberately unused — an Express error handler's four-argument
  arity, a Request that carries no fields yet — cannot be written to satisfy both.

**Prettier** — `singleQuote`, `semi`, `trailingComma: all`, `printWidth: 100`.

**Comments.** Density here is high on purpose: comments explain _why_, especially where a
line is load-bearing for correctness or security. A comment restating the code is noise; a
comment recording the decision behind it survives the next refactor.

---

## 10. Testing

- **Fakes at the DAO seam, not SDK mocks.** Hand-written in-memory fakes keep the assertions
  about behavior, and let a test check the exact command issued — `ConditionExpression`
  included — with no AWS SDK involved.
- **One black-box contract test per handler**, driving real event payloads through the
  actual entry point. This is what catches integration-shaped breakage that unit tests miss.
- **Pin the invariants that are easy to regress silently:** the route table matches the
  infrastructure's, the gated-route list matches the routes actually wearing the guard,
  logs never contain a credential.
- **Type-check the tests.** If `tsconfig.json` has `"include": ["src"]`, no test file is
  compiled, and every fake is validated only by running. That gap let a transposed
  constructor argument through here. Add a `tsconfig.test.json` from day one.
