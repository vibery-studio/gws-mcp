import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Test-only binding defined in vitest.config.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

// Setup files may run more than once; applyD1Migrations only applies pending migrations.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Test-only access rules: the reserved test domains the suite signs in with may use the server, as regular users.
// Tests that need an admin, or an empty list (the first sign-in), set that up in their own file. Storage is per
// worker: files run one after another in a worker share it, and this setup runs again before each file.
// Never seeded outside tests: the deployed list lives only in D1.
await env.DB.prepare(
  `INSERT OR IGNORE INTO access_rules (pattern, role, note, created_by, created_at) VALUES
     ('@fake.test', 'user', 'test suite', 'test-setup', 0),
     ('@example.test', 'user', 'test suite', 'test-setup', 0)`,
).run();
