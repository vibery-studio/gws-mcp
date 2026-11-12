/** Every structured error code the server can return. One code per distinct failure class. */
export const GWS_ERROR_CODES = [
  "GWS_UNKNOWN_METHOD",
  "GWS_INVALID_INPUT",
  "GWS_RESPONSE_SHAPE",
  "GWS_SCOPE_MISSING",
  "GWS_ACCOUNT_UNKNOWN",
  "GWS_ACCOUNT_DENIED",
  "GWS_NO_DEFAULT_ACCOUNT",
  "GWS_RECONNECT_REQUIRED",
  "GWS_ACCOUNT_TAKEN",
  // Only an admin of this gws-mcp's access list may call sdk.access.* (not a Google Workspace admin).
  "GWS_ACCESS_ADMIN_REQUIRED",
  // Google refused a Groups call because the account is not a Google Workspace admin (or is a personal account).
  "GWS_ADMIN_REQUIRED",
  // A Google Ads call needs the user's developer token, and none is saved. No Google request was made.
  "GWS_ADS_DEVELOPER_TOKEN_MISSING",
  // A saved setting can no longer be decrypted (the server's encryption key changed, say); saving it again fixes it.
  "GWS_SETTING_UNREADABLE",
  // This runtime cannot do it at all (the local stdio server has no web page for a one-time link).
  "GWS_UNSUPPORTED_RUNTIME",
  "GWS_CONFIRMATION_REQUIRED",
  // A step of the plan needs a person's approval on a gws-mcp page first (GWS_HUMAN_APPROVAL). No Google write was made.
  "GWS_APPROVAL_REQUIRED",
  "GWS_RATE_LIMITED",
  "GWS_CALL_BUDGET_EXCEEDED",
  "GWS_RESPONSE_TOO_LARGE",
  "GWS_UPSTREAM_ERROR",
  "GWS_EXECUTION_TIMEOUT",
  "GWS_EXECUTION_ERROR",
  "GWS_INTERNAL",
] as const;

export type GwsErrorCode = (typeof GWS_ERROR_CODES)[number];

/** The only error shape that crosses a boundary (RPC to the sandbox, MCP tool output). No stack, ever. */
export interface WireError {
  code: GwsErrorCode;
  message: string;
  fn?: string;
  account?: string;
  details?: Record<string, unknown>;
}

export interface GwsErrorOptions {
  details?: Record<string, unknown>;
  fn?: string;
  account?: string;
  cause?: unknown;
}

const BRAND = Symbol.for("gws-mcp.GwsError");

export class GwsError extends Error {
  readonly code: GwsErrorCode;
  readonly details?: Record<string, unknown>;
  readonly fn?: string;
  readonly account?: string;
  readonly [BRAND] = true;

  constructor(code: GwsErrorCode, message: string, opts: GwsErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "GwsError";
    this.code = code;
    if (opts.details !== undefined) this.details = opts.details;
    if (opts.fn !== undefined) this.fn = opts.fn;
    if (opts.account !== undefined) this.account = opts.account;
  }
}

export function isGwsError(e: unknown): e is GwsError {
  return e instanceof GwsError || (typeof e === "object" && e !== null && (e as { [BRAND]?: unknown })[BRAND] === true);
}

/**
 * Credential-shaped strings that must never leave the host inside an error.
 * Defense in depth: callers must not put credentials in messages in the first place.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /ya29\.[A-Za-z0-9_\-.]+/g,
  // Refresh tokens ("1//..."), also URL-encoded.
  /1(?:\/\/|%2F%2F)[A-Za-z0-9_\-]+/gi,
  // Authorization codes ("4/0..."), also URL-encoded.
  /\b4(?:\/|%2F)0[A-Za-z0-9_\-]+/gi,
  // OAuth client secrets.
  /GOCSPX-[A-Za-z0-9_\-]+/g,
  /Bearer\s+[A-Za-z0-9._\-~+/]+=*/gi,
  // Anchored after a non-word character: unanchored, "eyJ".repeat(n) retries at every "eyJ" (quadratic).
  /(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
];

/**
 * Keys whose values are credentials whatever they look like. Broad on purpose: a redacted
 * harmless value (e.g. a page token) costs nothing, a leaked credential costs everything.
 */
const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|credential|assertion|code_verifier|refresh|api[_-]?key|private[_-]?key|^key$/i;
/** A string under `code` is an OAuth authorization code; numeric codes are HTTP/RPC statuses and stay. */
const CODE_KEY = /^code$/i;

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;
/** Longest fn name, account ref or detail key echoed back, in UTF-16 units. */
const MAX_ECHO = 256;
/** Longest message or detail string echoed back, in UTF-16 units. */
const MAX_TEXT = 1000;
/**
 * Control (Cc) and format (Cf) characters: terminal escapes, NUL, line breaks, bidi overrides, zero-width
 * characters. Removed rather than replaced, so a token split by them is whole again for TOKEN_PATTERNS.
 */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

function redactTokens(s: string): string {
  return TOKEN_PATTERNS.reduce((acc, re) => acc.replace(re, REDACTED), s);
}

/** Cuts `s` to at most `max` UTF-16 units, never between the halves of a surrogate pair. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * Text that may echo snippet input (fn names, account refs, validation paths, upstream text) before it
 * leaves the host: controls stripped first, then credentials redacted, then the length capped, so the
 * output can neither carry injected control sequences nor a secret, and stays small.
 */
function scrubString(s: string, max = MAX_TEXT): string {
  return clip(redactTokens(s.replace(CONTROL_OR_FORMAT, "")), max);
}

function isBinary(v: object): boolean {
  return (
    v instanceof ArrayBuffer ||
    ArrayBuffer.isView(v) ||
    (typeof Blob !== "undefined" && v instanceof Blob) ||
    typeof (v as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Fails closed: anything it cannot inspect safely becomes a placeholder, never the raw value. */
function scrubValue(v: unknown, depth: number): unknown {
  if (typeof v === "string") return scrubString(v);
  if (v === null || typeof v !== "object") return typeof v === "function" || typeof v === "symbol" ? "[OBJECT]" : v;
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (isBinary(v)) return "[BINARY]";
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1));
  if (!isPlainObject(v)) return "[OBJECT]";
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const secret = SECRET_KEY.test(k) || (CODE_KEY.test(k) && typeof x === "string");
    out[scrubString(k, MAX_ECHO)] = secret ? REDACTED : scrubValue(x, depth + 1);
  }
  return out;
}

/** Converts any thrown value to the wire shape. Foreign errors never leak their message; all text is scrubbed. */
export function toWire(e: unknown): WireError {
  if (!isGwsError(e)) return { code: "GWS_INTERNAL", message: "internal error" };
  const wire: WireError = { code: e.code, message: scrubString(e.message) };
  if (e.fn !== undefined) wire.fn = scrubString(e.fn, MAX_ECHO);
  if (e.account !== undefined) wire.account = scrubString(e.account, MAX_ECHO);
  if (e.details !== undefined) wire.details = scrubValue(e.details, 0) as Record<string, unknown>;
  return wire;
}
