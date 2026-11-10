import { GwsError } from "../errors";

const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
const REQUEST_INFO = "type.googleapis.com/google.rpc.RequestInfo";

/**
 * Upstream strings that may cross the wire must match these shapes. Anything else (free text, which could
 * echo request data or other upstream body content) is dropped.
 */
const GOOGLE_STATUS_RE = /^[A-Z][A-Z_]{0,63}$/;
const REASON_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:\-]{1,128}$/;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function matching(v: unknown, re: RegExp): string | undefined {
  return typeof v === "string" && re.test(v) ? v : undefined;
}

function parseEnvelope(body: string): Json | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return isObject(parsed) && isObject(parsed.error) ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

function detail(error: Json, type: string): Json | undefined {
  return Array.isArray(error.details) ? error.details.find((d): d is Json => isObject(d) && d["@type"] === type) : undefined;
}

/**
 * Maps a non-2xx Google response to a GwsError. Only the HTTP status, Google's `error.status`, the error reason
 * (ErrorInfo, else the legacy `errors[0].reason`) and the RequestInfo request id are kept, each only when it
 * has the expected shape. Upstream messages and bodies never reach the message or the details.
 */
export function mapUpstreamError(status: number, body: string): GwsError {
  const error = parseEnvelope(body);
  const details: Record<string, unknown> = { status };
  if (error) {
    const legacy = Array.isArray(error.errors) && isObject(error.errors[0]) ? error.errors[0].reason : undefined;
    const reason = matching(detail(error, ERROR_INFO)?.reason, REASON_RE) ?? matching(legacy, REASON_RE);
    const googleStatus = matching(error.status, GOOGLE_STATUS_RE);
    const requestId = matching(detail(error, REQUEST_INFO)?.requestId, REQUEST_ID_RE);
    if (reason !== undefined) details.reason = reason;
    if (googleStatus !== undefined) details.googleStatus = googleStatus;
    if (requestId !== undefined) details.requestId = requestId;
  }
  const { reason, googleStatus } = details as { reason?: string; googleStatus?: string };
  const message = `Google API error ${status}${googleStatus ? ` ${googleStatus}` : ""}${reason ? ` (${reason})` : ""}`;
  if (status === 403 && reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") {
    return new GwsError("GWS_SCOPE_MISSING", `${message}: the account's grant lacks a scope this method needs`, { details });
  }
  return new GwsError("GWS_UPSTREAM_ERROR", message, { details });
}
