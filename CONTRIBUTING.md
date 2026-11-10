# Contributing

Issues and pull requests are welcome at https://github.com/vibery-studio/gws-mcp. Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Setup

You need Node.js 22.13 or later. No Google or Cloudflare account is needed: the tests use an in-repo fake Google, and the tracked `wrangler.example.jsonc`.

```bash
npm ci
```

## Checks a pull request must pass (CI runs the same ones)

```bash
npm run typecheck
npm test                         # all three vitest projects; or one: npx vitest run --project workers|node|local
npm run gen:check                # the committed SDK is byte-identical to a fresh generation
```

- **Local mode end to end:** `npm run build:local && npm run e2e:local`. This runs the bundled CLI against a fake Google on 127.0.0.1, in temp config folders. It never touches your keychain or a real account.
- **Remote mode end to end:** see [scripts/e2e/README.md](scripts/e2e/README.md).

## Generated SDK

`src/sdk/generated/**` is generated from the pinned Discovery documents in `discovery/`. Never edit it by hand.

- After changing the generator or the documents, run `npm run gen` and commit the output.
- `npm run discovery:fetch` refreshes the pinned documents.
- After changing `wrangler.example.jsonc`, run `npm run types`.

## Conventions

- **Structure.**
  - TypeScript strict and ESM. Validate input with zod at every boundary.
  - The platform-free core (`src/core`, `src/sdk` and the Google request helpers) depends only on the ports in `src/core/ports.ts`. Workers adapters live in `src/runtime/workers`, and Node adapters in `src/local`. `test/node/core-boundary.test.ts` enforces the boundary.
- **Behaviour and tests.**
  - Every new behaviour gets a test, covering the happy path and the failure cases that matter.
  - Fix the cause of a flaky test; never add retries.
  - Keep the dry-run guard: a write must change nothing until `apply: true`.
- **Secrets and config.**
  - Secrets come from a hidden prompt or stdin, never from arguments, logs or output.
  - Never commit `.env`, `.dev.vars` or a `wrangler.jsonc` with real ids.
  - Docs and printed hints use the scoped package `@bnqtoan/gws-mcp`. The unscoped npm name `gws-mcp` is an unrelated project.
- **Style.** Use kebab-case for new file names, and conventional commit messages (`feat:`, `fix:`, `docs:`, …).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
