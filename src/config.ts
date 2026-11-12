import { z } from "zod";
import { DESTRUCTIVE_REASON_WORDS, type DestructiveReason } from "./core/destructive";
import { GwsError } from "./errors";

/** Fake OAuth client used in `fake` upstream mode, so the real Google client secret never reaches the fake. */
export const FAKE_CLIENT_ID = "gws-mcp-fake-client";
export const FAKE_CLIENT_SECRET = "gws-mcp-fake-secret";

/** The only hosts the server may call in `google` upstream mode. */
export const GOOGLE_HOSTS = [
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
] as const;
export type GoogleHost = (typeof GOOGLE_HOSTS)[number];

export const GOOGLE_SERVICES = ["gmail", "drive", "calendar", "sheets", "docs", "forms", "tasks", "slides", "searchconsole", "analytics", "analyticsadmin", "ads", "groups", "tagmanager", "tagmanageredit", "tagmanagerpublish", "tagmanageradmin"] as const;
export type GoogleService = (typeof GOOGLE_SERVICES)[number];

/**
 * The services a one-click connect asks for: a new user's first sign-in, "Add Google account" and the local
 * `connect` without `--services`. Everything else is opt-in, added deliberately per account: Google Ads (can
 * spend money), Google Groups (Workspace admins only), Analytics editing, and Tag Manager editing,
 * publishing and administration (they change a live website or who can use it).
 */
export const DEFAULT_CONNECT_SERVICES: readonly GoogleService[] = [
  "gmail",
  "drive",
  "calendar",
  "sheets",
  "docs",
  "forms",
  "tasks",
  "slides",
  "searchconsole",
  "analytics",
  "tagmanager",
];

export const SCOPE_PRESETS = ["narrow", "full"] as const;
export type ScopePreset = (typeof SCOPE_PRESETS)[number];

const G = "https://www.googleapis.com/auth/";

/** Scopes requested per service when connecting an account. `narrow` keeps Google verification feasible. */
export const SERVICE_SCOPES: Readonly<Record<ScopePreset, Readonly<Record<GoogleService, readonly string[]>>>> = {
  narrow: {
    gmail: [`${G}gmail.readonly`, `${G}gmail.send`],
    drive: [`${G}drive.file`],
    calendar: [`${G}calendar.events`, `${G}calendar.calendarlist.readonly`],
    sheets: [`${G}spreadsheets`],
    docs: [`${G}documents`],
    forms: [`${G}forms.body`, `${G}forms.responses.readonly`],
    tasks: [`${G}tasks`],
    slides: [`${G}presentations`],
    searchconsole: [`${G}webmasters.readonly`],
    analytics: [`${G}analytics.readonly`],
    analyticsadmin: [`${G}analytics.edit`],
    ads: [`${G}adwords`],
    groups: [`${G}admin.directory.group.readonly`, `${G}admin.directory.group.member.readonly`, `${G}apps.groups.settings`],
    tagmanager: [`${G}tagmanager.readonly`],
    tagmanageredit: [`${G}tagmanager.edit.containers`],
    tagmanagerpublish: [`${G}tagmanager.edit.containerversions`, `${G}tagmanager.publish`],
    tagmanageradmin: [`${G}tagmanager.manage.accounts`, `${G}tagmanager.manage.users`, `${G}tagmanager.delete.containers`],
  },
  full: {
    gmail: ["https://mail.google.com/"],
    drive: [`${G}drive`],
    calendar: [`${G}calendar`],
    sheets: [`${G}spreadsheets`],
    docs: [`${G}documents`],
    forms: [`${G}forms.body`, `${G}forms.responses.readonly`],
    tasks: [`${G}tasks`],
    slides: [`${G}presentations`],
    searchconsole: [`${G}webmasters`],
    analytics: [`${G}analytics.readonly`],
    analyticsadmin: [`${G}analytics.edit`],
    ads: [`${G}adwords`],
    groups: [`${G}admin.directory.group`, `${G}admin.directory.group.member`, `${G}apps.groups.settings`],
    tagmanager: [`${G}tagmanager.readonly`],
    tagmanageredit: [`${G}tagmanager.edit.containers`],
    tagmanagerpublish: [`${G}tagmanager.edit.containerversions`, `${G}tagmanager.publish`],
    tagmanageradmin: [`${G}tagmanager.manage.accounts`, `${G}tagmanager.manage.users`, `${G}tagmanager.delete.containers`],
  },
};

/**
 * Per service: whether `scopes` hold every scope the connect flow asks for it under `preset`. Scopes this
 * build does not know (from a future preset, say) are ignored, and no other scope stands in for a service's
 * own: an account connected before a service existed reports it as not granted.
 */
export function grantedServices(preset: ScopePreset, scopes: Iterable<string>): Record<GoogleService, boolean> {
  const granted = new Set(scopes);
  const asked = SERVICE_SCOPES[preset];
  return Object.fromEntries(GOOGLE_SERVICES.map((s) => [s, asked[s].every((scope) => granted.has(scope))])) as Record<GoogleService, boolean>;
}

/** Names of Worker secrets. Values are read only through `requireSecret`. */
export type SecretName = "TOKEN_ENC_KEY" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An origin (no path, query or fragment), returned without a trailing slash. */
function origin(opts: { allowPlainHttp: "loopback" | "any" }) {
  return z.string().transform((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be an absolute URL" });
      return z.NEVER;
    }
    const isHttps = url.protocol === "https:";
    const httpOk = url.protocol === "http:" && (opts.allowPlainHttp === "any" || LOOPBACK.has(url.hostname));
    if (!isHttps && !httpOk) {
      ctx.addIssue({ code: "custom", message: "must use https (http only for loopback)" });
      return z.NEVER;
    }
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      ctx.addIssue({ code: "custom", message: "must be an origin without path, query or credentials" });
      return z.NEVER;
    }
    return url.origin;
  });
}

/**
 * A positive integer limit with a default and an upper bound. The bound fails the config load closed, so a
 * mistyped var (an extra zero, "1e12", "Infinity") cannot effectively disable a limit.
 */
const limit = (def: number, max: number) => z.coerce.number().int().positive().max(max).default(def);

/** The public origin: https, plain http only on loopback. */
const PublicOrigin = origin({ allowPlainHttp: "loopback" });

const ConfigSchema = z
  .object({
    GOOGLE_UPSTREAM: z.enum(["google", "fake"]),
    /**
     * Required here, optional in a deployment's vars: the Worker entry fills it in per request (`publicBaseUrl`)
     * before any code reads config, and the local runtime always sets it.
     */
    PUBLIC_BASE_URL: PublicOrigin,
    FAKE_GOOGLE_PUBLIC_URL: origin({ allowPlainHttp: "any" }).optional(),
    GOOGLE_SCOPE_PRESET: z.enum(SCOPE_PRESETS).default("narrow"),
    /**
     * Which Google accounts may sign in as their user. `primary`: only the account that created the user.
     * `active`: also any of the user's other accounts while it is active. The primary always may, even when
     * disconnected (sign-in never revives it); a secondary account that is not active never signs in.
     */
    LOGIN_ACCOUNTS: z.enum(["primary", "active"]).default("primary"),
    CALLS_PER_EXECUTE: limit(50, 500),
    /** One upstream response. */
    CALL_RESPONSE_MAX_BYTES: limit(4_000_000, 32_000_000),
    RESULT_MAX_BYTES: limit(200_000, 4_000_000),
    RATE_USER_PER_MIN: limit(300, 10_000),
    RATE_CLIENT_PER_MIN: limit(120, 10_000),
    SEARCH_MAX_BYTES: limit(8000, 200_000),
    EXECUTE_TIMEOUT_MS: limit(45_000, 300_000),
    /** All upstream responses of one execute together; bounded well below the isolate's 128 MB. */
    EXECUTE_RESPONSE_MAX_BYTES: limit(16_000_000, 64_000_000),
    /** Upstream calls in flight at once in one execute; more wait for a slot. Workers allow 6 open connections. */
    UPSTREAM_CONCURRENCY: limit(4, 6),
    /** One SDK call's input from the sandbox, measured before the dispatcher walks it; sized for media uploads. */
    CALL_INPUT_MAX_BYTES: limit(5_000_000, 32_000_000),
    /**
     * Which destructive reasons need a person's approval (`off`, or a comma list); parsed by `parseHumanApproval`. A
     * list is the already parsed value of a loaded config fed back in.
     */
    GWS_HUMAN_APPROVAL: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.GOOGLE_UPSTREAM === "fake" && c.FAKE_GOOGLE_PUBLIC_URL === undefined) {
      ctx.addIssue({ code: "custom", path: ["FAKE_GOOGLE_PUBLIC_URL"], message: "required in fake mode" });
    }
  });

/** Exactly the non-secret keys config reads. Anything else in env (secrets included) is never touched. */
const CONFIG_KEYS = Object.keys(ConfigSchema.shape) as Array<keyof z.input<typeof ConfigSchema>>;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export type ConfigEnv = { readonly [K in ConfigKey]?: unknown };

/**
 * Destructive reasons a person may be asked to approve: every reason a Google request can carry. `disconnect` is
 * left out because it is never a Google request (it is the accounts capability), so no approval could guard it.
 */
export type HumanApprovalReason = Exclude<DestructiveReason, "disconnect">;
export const HUMAN_APPROVAL_REASONS: readonly HumanApprovalReason[] = (Object.keys(DESTRUCTIVE_REASON_WORDS) as DestructiveReason[]).filter(
  (r): r is HumanApprovalReason => r !== "disconnect",
);

/** The reasons that need a person's approval on a web target unless GWS_HUMAN_APPROVAL says otherwise. */
export const DEFAULT_HUMAN_APPROVAL: readonly HumanApprovalReason[] = ["spend", "public-share", "owner-transfer", "permission-change", "publish"];

/** Where the config is loaded: a web target (Workers, the Node host) or the local stdio server, which has no web page. */
export type ConfigRuntime = "web" | "local";

function isHumanApprovalReason(value: string): value is HumanApprovalReason {
  return (HUMAN_APPROVAL_REASONS as readonly string[]).includes(value);
}

/**
 * GWS_HUMAN_APPROVAL: `off` (an empty list), or a comma list of reasons. Unset or blank is the default: the
 * DEFAULT_HUMAN_APPROVAL list on a web target, `off` on the local server. The local server has no page where a person
 * could approve, so any other value there is refused. A list (a loaded config's own value) is checked the same way,
 * empty meaning off. Errors never echo the value.
 */
export function parseHumanApproval(raw: unknown, runtime: ConfigRuntime): readonly HumanApprovalReason[] {
  let items: string[];
  if (Array.isArray(raw)) {
    items = raw.map((r) => (typeof r === "string" ? r : ""));
  } else if (raw === undefined || typeof raw === "string") {
    const text = (raw ?? "").trim().toLowerCase();
    if (text === "") return runtime === "web" ? DEFAULT_HUMAN_APPROVAL : [];
    if (text === "off") return [];
    items = text.split(",").map((s) => s.trim());
  } else {
    throw humanApprovalInvalid();
  }
  if (items.length === 0) return [];
  if (items.some((r) => !isHumanApprovalReason(r))) throw humanApprovalInvalid();
  if (runtime === "local") {
    throw new GwsError(
      "GWS_INTERNAL",
      "GWS_HUMAN_APPROVAL can only be off on this computer: the local gws-mcp has no web page where a person could approve a plan. Remove the setting, or set it to off",
      { details: { keys: ["GWS_HUMAN_APPROVAL"] } },
    );
  }
  return [...new Set(items as HumanApprovalReason[])];
}

function humanApprovalInvalid(): GwsError {
  return new GwsError("GWS_INTERNAL", `invalid config: GWS_HUMAN_APPROVAL must be off or a comma list of these reasons: ${HUMAN_APPROVAL_REASONS.join(", ")}`, {
    details: { keys: ["GWS_HUMAN_APPROVAL"] },
  });
}

export type Config = Omit<z.output<typeof ConfigSchema>, "GWS_HUMAN_APPROVAL"> & {
  /** The destructive reasons whose steps need a person's approval before they run; empty when off. */
  GWS_HUMAN_APPROVAL: readonly HumanApprovalReason[];
  /** Google OAuth redirect URI registered for this deployment. */
  redirectUri: string;
  /** Canonical MCP resource (token audience). */
  mcpResource: string;
};

/**
 * Parses and validates the config vars of `runtime` (a web target unless told otherwise). Errors name the offending
 * keys only, never values.
 */
export function loadConfig(env: ConfigEnv, runtime: ConfigRuntime = "web"): Config {
  const raw: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) raw[key] = env[key];
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "?")))].sort();
    throw new GwsError("GWS_INTERNAL", `invalid config: ${keys.join(", ")}`, { details: { keys } });
  }
  const c = parsed.data;
  const humanApproval = parseHumanApproval(c.GWS_HUMAN_APPROVAL, runtime);
  return { ...c, GWS_HUMAN_APPROVAL: humanApproval, redirectUri: `${c.PUBLIC_BASE_URL}/google/callback`, mcpResource: `${c.PUBLIC_BASE_URL}/mcp` };
}

/**
 * The public origin for one request: the `PUBLIC_BASE_URL` var when set (an override), else the origin of the URL
 * the request arrived on. Every public URL (Google redirect URI, MCP resource and token audience, CSRF Origin check,
 * links) is built from it.
 *
 * Only the runtime's request URL is used, never a forwarding header (X-Forwarded-Host and the like). On Workers its
 * host is one Cloudflare routed to this Worker (workers.dev, a route or a custom domain): a request whose Host names
 * another site is routed to that site, not here. The derived origin must pass the same check as the override (https,
 * plain http only on loopback); otherwise this returns null and the caller refuses the request. Whatever origin is
 * derived, Google and the fake send codes only to exactly registered redirect URIs, and MCP clients' redirect URIs
 * are matched exactly by the OAuth provider. An invalid override throws GWS_INTERNAL naming only the key.
 */
export function publicBaseUrl(env: ConfigEnv, requestUrl: string): string | null {
  const override = env.PUBLIC_BASE_URL;
  if (override !== undefined && override !== "") {
    const parsed = PublicOrigin.safeParse(override);
    if (!parsed.success) {
      throw new GwsError("GWS_INTERNAL", "invalid config: PUBLIC_BASE_URL", { details: { keys: ["PUBLIC_BASE_URL"] } });
    }
    return parsed.data;
  }
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  const derived = PublicOrigin.safeParse(url.origin);
  return derived.success ? derived.data : null;
}

/** Returns a Worker secret, or throws GWS_INTERNAL naming the secret. The value is never echoed. */
export function requireSecret(env: { readonly [K in SecretName]?: unknown }, name: SecretName): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new GwsError("GWS_INTERNAL", `missing secret ${name}`);
  }
  return value;
}
