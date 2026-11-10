// The test worker binds FAKE_GOOGLE through `serviceBindings` in vitest.config.ts; wrangler.example.jsonc (the
// source of the generated worker types) does not. Augments only `Cloudflare.Env`, the type of `env` from
// "cloudflare:workers" in tests; the source's global `Env` keeps the deployed bindings.
declare namespace Cloudflare {
  interface Env {
    FAKE_GOOGLE: Fetcher;
  }
}
