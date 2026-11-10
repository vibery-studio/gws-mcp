/** Replacement for every redacted credential. */
export const REDACTED = "[REDACTED]";

/**
 * Credential shapes, whatever text they appear in. The text is snippet-controlled, so every pattern must run
 * in linear time: a match may start only where no earlier start could have consumed it.
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

/** `client_secret` / `refresh_token` followed by `=` or `:` (JSON, form or header style): the value is redacted, the key kept. */
const SECRET_PAIR = /((?:client_secret|refresh_token)["']?\s*[:=]\s*["']?)[^"'\s&,;}]+/gi;

/** Known secret values shorter than this are not matched: they would redact ordinary words. */
const MIN_KNOWN_SECRET = 8;

/**
 * Replaces credential-shaped substrings and every exact occurrence of a known secret value (at least 8
 * characters) with `[REDACTED]`.
 */
export function redact(text: string, knownSecrets: readonly (string | undefined)[]): string {
  let out = text;
  const known = knownSecrets
    .filter((s): s is string => typeof s === "string" && s.length >= MIN_KNOWN_SECRET)
    .sort((a, b) => b.length - a.length);
  for (const secret of known) out = out.split(secret).join(REDACTED);
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  return out.replace(SECRET_PAIR, `$1${REDACTED}`);
}

/** Returns a copy of a JSON value with every string (object keys included) passed through `redact`. */
export function redactDeep(value: unknown, knownSecrets: readonly (string | undefined)[]): unknown {
  if (typeof value === "string") return redact(value, knownSecrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, knownSecrets));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[redact(k, knownSecrets)] = redactDeep(v, knownSecrets);
    return out;
  }
  return value;
}
