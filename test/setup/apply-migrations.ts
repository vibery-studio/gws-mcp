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
