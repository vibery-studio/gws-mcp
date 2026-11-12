import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONNECT_SERVICES,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  GOOGLE_HOSTS,
  GOOGLE_SERVICES,
  SERVICE_SCOPES,
  grantedServices,
  loadConfig,
  requireSecret,
  type Config,
} from "../../src/config";
import { SECRET_NAMES } from "../../src/contracts";
import { isGwsError } from "../../src/errors";
import { createTransport } from "../../src/google/transport";
import { generatedFns } from "../../src/sdk/generated/index";

const BASE = {
  GOOGLE_UPSTREAM: "fake",
  PUBLIC_BASE_URL: "https://gws-mcp.example.workers.dev",
  FAKE_GOOGLE_PUBLIC_URL: "https://gws-mcp-fake-google.example.workers.dev",
};

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("loadConfig", () => {
  it("applies defaults and derives URLs", () => {
    const c = loadConfig(BASE);
    expect(c.GOOGLE_UPSTREAM).toBe("fake");
    expect(c.GOOGLE_SCOPE_PRESET).toBe("narrow");
    expect(c.CALLS_PER_EXECUTE).toBe(50);
    expect(c.CALL_RESPONSE_MAX_BYTES).toBe(4_000_000);
    expect(c.RESULT_MAX_BYTES).toBe(200_000);
    expect(c.RATE_USER_PER_MIN).toBe(300);
    expect(c.RATE_CLIENT_PER_MIN).toBe(120);
    expect(c.SEARCH_MAX_BYTES).toBe(8000);
    expect(c.EXECUTE_TIMEOUT_MS).toBe(45_000);
    expect(c.EXECUTE_RESPONSE_MAX_BYTES).toBe(16_000_000);
    expect(c.UPSTREAM_CONCURRENCY).toBe(4);
    expect(c.CALL_INPUT_MAX_BYTES).toBe(5_000_000);
    expect(c.redirectUri).toBe("https://gws-mcp.example.workers.dev/google/callback");
    expect(c.mcpResource).toBe("https://gws-mcp.example.workers.dev/mcp");
  });

  it("coerces string vars to numbers", () => {
    const c = loadConfig({ ...BASE, CALLS_PER_EXECUTE: "7", RATE_CLIENT_PER_MIN: "3", EXECUTE_TIMEOUT_MS: "1000" });
    expect(c.CALLS_PER_EXECUTE).toBe(7);
    expect(c.RATE_CLIENT_PER_MIN).toBe(3);
    expect(c.EXECUTE_TIMEOUT_MS).toBe(1000);
  });

  it("strips a trailing slash and accepts loopback http", () => {
    const c = loadConfig({ ...BASE, PUBLIC_BASE_URL: "http://localhost:8787/" });
    expect(c.PUBLIC_BASE_URL).toBe("http://localhost:8787");
    expect(c.redirectUri).toBe("http://localhost:8787/google/callback");
  });

  it.each([
    ["bad upstream", { GOOGLE_UPSTREAM: "prod" }, "GOOGLE_UPSTREAM"],
    ["missing upstream", { GOOGLE_UPSTREAM: undefined }, "GOOGLE_UPSTREAM"],
    ["bad preset", { GOOGLE_SCOPE_PRESET: "wide" }, "GOOGLE_SCOPE_PRESET"],
    ["non-numeric limit", { CALLS_PER_EXECUTE: "many" }, "CALLS_PER_EXECUTE"],
    ["zero limit", { RESULT_MAX_BYTES: "0" }, "RESULT_MAX_BYTES"],
    ["plain http public host", { PUBLIC_BASE_URL: "http://gws-mcp.example.com" }, "PUBLIC_BASE_URL"],
    ["public URL with a path", { PUBLIC_BASE_URL: "https://gws-mcp.example.com/app" }, "PUBLIC_BASE_URL"],
    ["fake mode without fake URL", { FAKE_GOOGLE_PUBLIC_URL: undefined }, "FAKE_GOOGLE_PUBLIC_URL"],
  ])("rejects %s with GWS_INTERNAL naming the key", (_label, patch, key) => {
    const e = thrown(() => loadConfig({ ...BASE, ...patch }));
    expect(isGwsError(e)).toBe(true);
    if (!isGwsError(e)) return;
    expect(e.code).toBe("GWS_INTERNAL");
    expect(e.message).toContain(key);
  });

  // Upper bounds keep a mistyped var from disabling a limit; Workers allow 6 open upstream connections at once.
  const UPPER_BOUNDS: Array<[string, number]> = [
    ["CALLS_PER_EXECUTE", 500],
    ["CALL_RESPONSE_MAX_BYTES", 32_000_000],
    ["RESULT_MAX_BYTES", 4_000_000],
    ["RATE_USER_PER_MIN", 10_000],
    ["RATE_CLIENT_PER_MIN", 10_000],
    ["SEARCH_MAX_BYTES", 200_000],
    ["EXECUTE_TIMEOUT_MS", 300_000],
    ["EXECUTE_RESPONSE_MAX_BYTES", 64_000_000],
    ["UPSTREAM_CONCURRENCY", 6],
    ["CALL_INPUT_MAX_BYTES", 32_000_000],
  ];

  it.each(UPPER_BOUNDS)("accepts %s up to %i and rejects anything above, naming the key", (key, max) => {
    expect(loadConfig({ ...BASE, [key]: String(max) })[key as keyof Config]).toBe(max);
    for (const bad of [String(max + 1), "1e12", "Infinity", "1.5"]) {
      const e = thrown(() => loadConfig({ ...BASE, [key]: bad }));
      expect(isGwsError(e) && e.code === "GWS_INTERNAL" && e.message.includes(key), `${key}=${bad}`).toBe(true);
    }
  });

  it("bounds every numeric limit key", () => {
    const numeric = Object.entries(loadConfig(BASE))
      .filter(([, v]) => typeof v === "number")
      .map(([k]) => k)
      .sort();
    expect(numeric).toEqual(UPPER_BOUNDS.map(([k]) => k).sort());
  });

  it("lets only the primary account sign in unless LOGIN_ACCOUNTS says active", () => {
    expect(loadConfig(BASE).LOGIN_ACCOUNTS).toBe("primary");
    expect(loadConfig({ ...BASE, LOGIN_ACCOUNTS: "primary" }).LOGIN_ACCOUNTS).toBe("primary");
    expect(loadConfig({ ...BASE, LOGIN_ACCOUNTS: "active" }).LOGIN_ACCOUNTS).toBe("active");
    for (const bad of ["any", "ACTIVE", "", "all"]) {
      const e = thrown(() => loadConfig({ ...BASE, LOGIN_ACCOUNTS: bad }));
      expect(isGwsError(e) && e.code === "GWS_INTERNAL" && e.message.includes("LOGIN_ACCOUNTS"), bad).toBe(true);
    }
  });

  it("does not require the fake URL in google mode", () => {
    const c = loadConfig({ ...BASE, GOOGLE_UPSTREAM: "google", FAKE_GOOGLE_PUBLIC_URL: undefined });
    expect(c.GOOGLE_UPSTREAM).toBe("google");
    expect(c.FAKE_GOOGLE_PUBLIC_URL).toBeUndefined();
  });

  it("never copies secret bindings into the config", () => {
    const envWithSecrets = { ...BASE, TOKEN_ENC_KEY: "k".repeat(44), GOOGLE_CLIENT_SECRET: "s".repeat(24) };
    const c = loadConfig(envWithSecrets);
    expect(JSON.stringify(c)).not.toMatch(/kkkkkkkk|ssssssss/);
  });

  it("parses the worker test env", () => {
    const c = loadConfig(env);
    expect(c.GOOGLE_UPSTREAM).toBe("fake");
    expect(c.mcpResource).toBe("http://localhost/mcp");
  });
});

describe("requireSecret", () => {
  it("returns a present secret", () => {
    expect(requireSecret({ TOKEN_ENC_KEY: "value-1234" }, "TOKEN_ENC_KEY")).toBe("value-1234");
  });

  it.each([undefined, ""])("throws GWS_INTERNAL for %j without echoing values", (value) => {
    const e = thrown(() =>
      requireSecret({ TOKEN_ENC_KEY: value, GOOGLE_CLIENT_SECRET: "other-secret-value" }, "TOKEN_ENC_KEY"),
    );
    expect(isGwsError(e)).toBe(true);
    if (!isGwsError(e)) return;
    expect(e.code).toBe("GWS_INTERNAL");
    expect(e.message).toBe("missing secret TOKEN_ENC_KEY");
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain("other-secret-value");
  });
});

describe("constants", () => {
  it("defines fake client credentials distinct from any real secret name", () => {
    expect(FAKE_CLIENT_ID).toBe("gws-mcp-fake-client");
    expect(FAKE_CLIENT_SECRET).toBe("gws-mcp-fake-secret");
  });

  it("allowlists only Google hosts", () => {
    expect(GOOGLE_HOSTS).toContain("oauth2.googleapis.com");
    expect(GOOGLE_HOSTS).toContain("gmail.googleapis.com");
    for (const h of GOOGLE_HOSTS) expect(h).toMatch(/(^|\.)google(apis)?\.com$/);
  });

  it("allowlists exactly the identity hosts and the hosts the generated SDK calls", () => {
    expect([...GOOGLE_HOSTS].sort()).toEqual(
      [
        "accounts.google.com",
        "oauth2.googleapis.com",
        "openidconnect.googleapis.com",
        "www.googleapis.com",
        "gmail.googleapis.com",
        "sheets.googleapis.com",
        "docs.googleapis.com",
        "forms.googleapis.com",
        "tasks.googleapis.com",
        "slides.googleapis.com",
        "searchconsole.googleapis.com",
        "analyticsdata.googleapis.com",
        "analyticsadmin.googleapis.com",
        "admin.googleapis.com",
        "googleads.googleapis.com",
        "tagmanager.googleapis.com",
      ].sort(),
    );
    const generatedHosts = new Set(generatedFns.flatMap((fn) => (fn.method ? [new URL(fn.method.rootUrl).hostname] : [])));
    const identityHosts = ["accounts.google.com", "oauth2.googleapis.com", "openidconnect.googleapis.com"];
    // Nothing more than the identity hosts and the generated root URLs: every allowed API host is one the SDK calls.
    expect([...generatedHosts].sort()).toEqual(GOOGLE_HOSTS.filter((h) => !identityHosts.includes(h)).sort());
    // Group settings use the shared www.googleapis.com root.
    expect(generatedFns.find((fn) => fn.name === "groupsSettings.groups.get")?.method?.rootUrl).toBe("https://www.googleapis.com/");
  });

  it("connects in one click only the everyday services, never money, Workspace admin, or Analytics and Tag Manager changes", () => {
    expect([...DEFAULT_CONNECT_SERVICES]).toEqual(["gmail", "drive", "calendar", "sheets", "docs", "forms", "tasks", "slides", "searchconsole", "analytics", "tagmanager"]);
    expect(GOOGLE_SERVICES.filter((s) => !DEFAULT_CONNECT_SERVICES.includes(s))).toEqual([
      "analyticsadmin",
      "ads",
      "groups",
      "tagmanageredit",
      "tagmanagerpublish",
      "tagmanageradmin",
    ]);
  });

  it("defines scopes for every v1 service in both presets, narrow by default", () => {
    for (const preset of ["narrow", "full"] as const) {
      for (const svc of GOOGLE_SERVICES) {
        expect(SERVICE_SCOPES[preset][svc].length).toBeGreaterThan(0);
      }
    }
    expect(SERVICE_SCOPES.narrow.drive).toEqual(["https://www.googleapis.com/auth/drive.file"]);
    expect(SERVICE_SCOPES.narrow.gmail).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
  });

  it.each(["narrow", "full"] as const)("asks the same Forms, Tasks and Slides scopes in the %s preset", (preset) => {
    expect(SERVICE_SCOPES[preset].forms).toEqual([
      "https://www.googleapis.com/auth/forms.body",
      "https://www.googleapis.com/auth/forms.responses.readonly",
    ]);
    expect(SERVICE_SCOPES[preset].tasks).toEqual(["https://www.googleapis.com/auth/tasks"]);
    expect(SERVICE_SCOPES[preset].slides).toEqual(["https://www.googleapis.com/auth/presentations"]);
  });
});

describe("grantedServices", () => {
  const G = "https://www.googleapis.com/auth/";
  const FIVE_SERVICES = [`${G}gmail.readonly`, `${G}gmail.send`, `${G}drive.file`, `${G}calendar.events`, `${G}calendar.calendarlist.readonly`, `${G}spreadsheets`, `${G}documents`];

  it("reports the services added later as not granted on an account connected before them", () => {
    expect(grantedServices("narrow", FIVE_SERVICES)).toEqual({
      gmail: true,
      drive: true,
      calendar: true,
      sheets: true,
      docs: true,
      forms: false,
      tasks: false,
      slides: false,
      searchconsole: false,
      analytics: false,
      analyticsadmin: false,
      ads: false,
      groups: false,
      tagmanager: false,
      tagmanageredit: false,
      tagmanagerpublish: false,
      tagmanageradmin: false,
    });
  });

  it.each(["narrow", "full"] as const)("asks the four Tag Manager levels their own scopes in the %s preset", (preset) => {
    expect(SERVICE_SCOPES[preset].tagmanager).toEqual([`${G}tagmanager.readonly`]);
    expect(SERVICE_SCOPES[preset].tagmanageredit).toEqual([`${G}tagmanager.edit.containers`]);
    expect(SERVICE_SCOPES[preset].tagmanagerpublish).toEqual([`${G}tagmanager.edit.containerversions`, `${G}tagmanager.publish`]);
    expect(SERVICE_SCOPES[preset].tagmanageradmin).toEqual([
      `${G}tagmanager.manage.accounts`,
      `${G}tagmanager.manage.users`,
      `${G}tagmanager.delete.containers`,
    ]);
  });

  it("asks for the marketing and groups scopes in both presets", () => {
    const narrow = SERVICE_SCOPES.narrow;
    const full = SERVICE_SCOPES.full;
    expect(narrow.searchconsole).toEqual([`${G}webmasters.readonly`]);
    expect(full.searchconsole).toEqual([`${G}webmasters`]);
    for (const preset of [narrow, full]) {
      expect(preset.analytics).toEqual([`${G}analytics.readonly`]);
      expect(preset.analyticsadmin).toEqual([`${G}analytics.edit`]);
      expect(preset.ads).toEqual([`${G}adwords`]);
    }
    expect(narrow.groups).toEqual([`${G}admin.directory.group.readonly`, `${G}admin.directory.group.member.readonly`, `${G}apps.groups.settings`]);
    expect(full.groups).toEqual([`${G}admin.directory.group`, `${G}admin.directory.group.member`, `${G}apps.groups.settings`]);
  });

  it("counts a service only when every scope the connect flow asks for it is granted", () => {
    expect(grantedServices("narrow", [`${G}forms.body`]).forms).toBe(false);
    expect(grantedServices("narrow", [`${G}forms.body`, `${G}forms.responses.readonly`]).forms).toBe(true);
    // Drive-side access never stands in for a service's own scopes.
    expect(grantedServices("full", [`${G}drive`]).forms).toBe(false);
    expect(grantedServices("full", [`${G}drive`]).slides).toBe(false);
  });

  it("ignores scopes it does not know, such as one from a future preset", () => {
    const out = grantedServices("full", ["https://www.googleapis.com/auth/some.future.scope", "", `${G}tasks`]);
    expect(Object.keys(out).sort()).toEqual([...GOOGLE_SERVICES].sort());
    expect(out.tasks).toBe(true);
    expect(Object.values(out).filter(Boolean)).toHaveLength(1);
  });
});

describe("upstream host allowlist", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(): string[] {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("ok");
    });
    return calls;
  }

  it.each([
    "forms.googleapis.com",
    "tasks.googleapis.com",
    "slides.googleapis.com",
    "searchconsole.googleapis.com",
    "analyticsdata.googleapis.com",
    "analyticsadmin.googleapis.com",
    "admin.googleapis.com",
    "googleads.googleapis.com",
    "tagmanager.googleapis.com",
  ])("lets google mode call %s", async (host) => {
    const calls = stubFetch();
    const t = createTransport({}, { GOOGLE_UPSTREAM: "google" });
    await t(`https://${host}/v1/x`, { method: "GET" });
    expect(calls).toEqual([`https://${host}/v1/x`]);
  });

  it.each([
    "https://forms.googleapis.com.evil.example/v1/forms/x",
    "https://evilforms.googleapis.com/v1/forms/x",
    "https://tasks.googleapis.co/tasks/v1/users/@me/lists",
    "https://tasks.googleapis.com./tasks/v1/users/@me/lists",
    "https://tasks-googleapis.com/tasks/v1/users/@me/lists",
    "https://slides.googleapis.com@evil.example/v1/presentations/x",
    "https://slides.googleapis.com:444/v1/presentations/x",
    "http://slides.googleapis.com/v1/presentations/x",
    "https://f\u043erms.googleapis.com/v1/forms/x",
    "https://slides.google.com/v1/presentations/x",
    "https://googleads.googleapis.com.evil.example/v23/customers:listAccessibleCustomers",
    "https://evil-googleads.googleapis.com/v23/customers:listAccessibleCustomers",
    "https://xadmin.googleapis.com/admin/directory/v1/groups",
    "https://admin.googleapis.co/admin/directory/v1/groups",
    "https://admin.google.com/admin/directory/v1/groups",
    "https://analytics.googleapis.com/v1beta/properties/1:runReport",
    "https://analyticsdata.googleapis.com.evil.example/v1beta/properties/1:runReport",
    "https://searchconsole.googleapis.com@evil.example/webmasters/v3/sites",
    "https://tagmanager.googleapis.com:8443/tagmanager/v2/accounts",
    "http://tagmanager.googleapis.com/tagmanager/v2/accounts",
    "https://tagmanager-googleapis.com/tagmanager/v2/accounts",
    "https://t\u0430gmanager.googleapis.com/tagmanager/v2/accounts",
  ])("refuses the lookalike %s without calling fetch", async (url) => {
    const calls = stubFetch();
    const t = createTransport({}, { GOOGLE_UPSTREAM: "google" });
    let code: unknown;
    try {
      await t(url, { method: "GET" });
    } catch (e) {
      code = isGwsError(e) ? e.code : e;
    }
    expect(code).toBe("GWS_INTERNAL");
    expect(calls).toEqual([]);
  });
});

describe("test environment isolation", () => {
  // Must match the placeholder bindings in vitest.config.ts. Compared with `===` so a failure never prints a value.
  const PLACEHOLDER_CLIENT_ID = "test-placeholder-google-client-id";
  const PLACEHOLDER_CLIENT_SECRET = "test-placeholder-google-client-secret";

  it("binds fixed placeholders, never real Google client credentials, in the test worker", () => {
    expect(env.GOOGLE_CLIENT_ID === PLACEHOLDER_CLIENT_ID).toBe(true);
    expect(env.GOOGLE_CLIENT_SECRET === PLACEHOLDER_CLIENT_SECRET).toBe(true);
  });
});

describe("host worker process.env", () => {
  it("is not populated from bindings, so dependencies cannot read secrets from it", () => {
    const keys = Object.keys(process.env);
    for (const name of [...SECRET_NAMES, "GOOGLE_UPSTREAM", "PUBLIC_BASE_URL"]) {
      expect(keys.includes(name), name).toBe(false);
    }
  });
});
