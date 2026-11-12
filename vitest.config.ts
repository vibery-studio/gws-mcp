import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { createFakeGoogle } from "./fake-google/src/app";
import { MemoryStore } from "./fake-google/src/store";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from "./src/config";

// Without a .dev.vars file, wrangler would load the repo's .env (real Google client credentials)
// into the test worker's bindings. Tests must only ever see the fixed values below.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";

/** Fixed, test-only AES-256 key (32 bytes, base64). Never used outside tests. */
const TEST_TOKEN_ENC_KEY = btoa("gws-mcp-test-only-key-0123456789");

/** One in-process fake Google for the whole run; tests isolate by unique account emails. */
const fakeGoogle = createFakeGoogle({
  store: new MemoryStore(),
  signingKey: "gws-mcp-test-only-fake-signing-key",
  clientId: FAKE_CLIENT_ID,
  clientSecret: FAKE_CLIENT_SECRET,
  // Exactly the callback gws-mcp derives from PUBLIC_BASE_URL below, as registered with a real Google client.
  redirectUris: ["http://localhost/google/callback"],
});

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/node/**/*.test.ts", "test/node-host/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "local",
          environment: "node",
          include: ["test/local/**/*.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            // The tracked template, never an operator's untracked wrangler.jsonc: a fresh clone runs the same suite.
            wrangler: { configPath: "./wrangler.example.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
                TOKEN_ENC_KEY: TEST_TOKEN_ENC_KEY,
                // Fixed placeholders win over anything wrangler might load from local secret files.
                GOOGLE_CLIENT_ID: "test-placeholder-google-client-id",
                GOOGLE_CLIENT_SECRET: "test-placeholder-google-client-secret",
                // The override path; test/web/public-url.test.ts covers the origin derived from the request.
                PUBLIC_BASE_URL: "http://localhost",
                // Tests always run against the in-process fake Google with the narrow preset, whatever
                // a wrangler config deploys: without these pins the suite would call real Google.
                GOOGLE_UPSTREAM: "fake",
                GOOGLE_SCOPE_PRESET: "narrow",
                FAKE_GOOGLE_PUBLIC_URL: "http://fake-google.test",
              },
              serviceBindings: {
                FAKE_GOOGLE: (request: Request) => fakeGoogle(request),
              },
            },
          })),
        ],
        test: {
          name: "workers",
          // Reuse each test worker across files. With per-file isolation every file re-fetched the whole
          // generated SDK (2.5 MB) through the pool's main-thread serializer, stalling that thread for
          // seconds and timing out unrelated short tests under load. Parallel workers still get separate
          // storage; files run one after another in a worker share it, so a test asserts only its own rows.
          isolate: false,
          include: ["test/**/*.test.ts"],
          exclude: ["test/node/**", "test/node-host/**", "test/local/**"],
          setupFiles: ["./test/setup/apply-migrations.ts"],
        },
      },
    ],
  },
});
