# Releasing `@freemail/client`

`packages/client` is published to npm as [`@freemail/client`](https://www.npmjs.com/package/@freemail/client). Pushing a `client-v<version>` tag runs `.github/workflows/publish-client.yml`, which has two jobs:

- **build** installs, lints, builds and tests, then packs the tarball. It runs without the OIDC token.
- **publish** stages that tarball on npm through trusted publishing: GitHub's OIDC token stands in for an npm token, and npm records provenance. It runs nothing from the repository.

A staged version isn't public until a maintainer approves it with 2FA.

## Release a version

1. In a PR, bump `version` in `packages/client/package.json` ([semver](https://semver.org): a breaking change to the client's API is a major bump). Merge it.
2. Tag the merge commit on `main` and push the tag:

   ```sh
   git fetch origin
   git tag client-v0.2.0 origin/main
   git push origin client-v0.2.0
   ```

   The workflow refuses a tag that doesn't match the package version or isn't on `main`. A prerelease (`0.2.0-beta.1`) goes out under the `next` dist-tag; anything else under `latest`. A fix to an older line (a version below the current `latest`) needs a dist-tag of its own, which the workflow doesn't choose, so publish that one by hand.

3. When the workflow finishes, approve the staged version on npmjs.com (the package's staged versions), or with `npm stage list @freemail/client` and `npm stage approve <stage-id>`. Both ask for 2FA.

## One-time setup

1. **Claim the scope.** On npmjs.com, [create the organization](https://www.npmjs.com/org/create) `freemail` (free for public packages), with 2FA on your account.
2. **Publish the first version from your terminal.** npm attaches a trusted publisher to a package that already exists, so the first version can't come from the workflow:

   ```sh
   npm login
   npm ci && npm run build && npm test -w @freemail/client
   cd packages/client && npm publish
   ```

   `publishConfig.access` in `packages/client/package.json` makes it public.

3. **Add the trusted publisher** when you are ready to release the next version: a new trusted publisher configuration expires if it hasn't published within 2 days. On the package's **Settings** page on npmjs.com, add a GitHub Actions trusted publisher:
   - Organization or user: `Nan0416`
   - Repository: `FreeMail`
   - Workflow filename: `publish-client.yml`
   - Environment: leave empty

   Then release as above, and approve the staged version within those 2 days.

4. **Turn tokens off.** Under **Settings → Publishing access**, choose _Require two-factor authentication and disallow tokens_. Trusted publishing keeps working; a leaked token can't publish.

Trusted publishing needs npm 11.5.1 or later (staging needs 11.15.0); the workflow pins npm 12.2.3. The `repository` URL in `packages/client/package.json` must stay `git+https://github.com/Nan0416/FreeMail.git`, the repository npm checks the publish against.
