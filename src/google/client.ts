import type { MethodMeta } from "../contracts";
import { GwsError, isGwsError } from "../errors";
import { mapUpstreamError } from "./errors";
import { mediaResult, wantsMediaDownload, type MediaResult } from "./media";
import { buildRequest } from "./request";
import type { Transport } from "./transport";

export interface CallGoogleOptions {
  accessToken: string;
  transport: Transport;
  /** Most bytes read from any response body, success or error. Larger bodies are refused without being buffered. */
  maxResponseBytes: number;
}

function tooLarge(status: number, bytes: number, max: number): GwsError {
  return new GwsError("GWS_RESPONSE_TOO_LARGE", `the Google API response is larger than ${max} bytes`, {
    details: { scope: "call", status, bytes, max },
  });
}

/**
 * Reads a response body, refusing it as soon as it passes `max` bytes: first from a declared Content-Length,
 * then by counting streamed chunks, so an oversized body is never held in memory. On overflow the stream is
 * cancelled; a failure to cancel is ignored because the body is being abandoned and the overflow is what is reported.
 */
async function readBounded(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge(res.status, declared, max);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(res.status, total, max);
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const utf8 = new TextDecoder();

/**
 * Calls one Google method exactly once: builds the request, sends it through the transport (never retried,
 * never following redirects), reads the body under `maxResponseBytes`, maps non-2xx responses, and returns
 * parsed JSON (`{}` for an empty body) or a media result. Schema validation of the result belongs to the dispatcher.
 */
export async function callGoogle(meta: MethodMeta, input: unknown, opts: CallGoogleOptions): Promise<unknown | MediaResult> {
  if (typeof opts.accessToken !== "string" || opts.accessToken === "") {
    throw new GwsError("GWS_INTERNAL", "callGoogle needs an access token");
  }
  if (!Number.isSafeInteger(opts.maxResponseBytes) || opts.maxResponseBytes <= 0) {
    throw new GwsError("GWS_INTERNAL", "callGoogle needs a positive integer maxResponseBytes");
  }
  const req = buildRequest(meta, input, { accessToken: opts.accessToken });
  const init: RequestInit = { method: req.method, headers: req.headers, redirect: "manual" };
  if (req.body !== undefined) init.body = req.body;

  let res: Response;
  try {
    res = await opts.transport(req.url, init);
  } catch (e) {
    if (isGwsError(e)) throw e;
    // The write may or may not have reached Google; it is never retried.
    throw new GwsError("GWS_UPSTREAM_ERROR", "the Google API request failed before a response", {
      details: { status: 0 },
      cause: e,
    });
  }

  const bytes = await readBounded(res, opts.maxResponseBytes);
  if (res.status < 200 || res.status > 299) throw mapUpstreamError(res.status, utf8.decode(bytes));
  if (wantsMediaDownload(meta, input as Record<string, unknown>)) return mediaResult(bytes, res.headers.get("content-type"));
  const text = utf8.decode(bytes);
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GwsError("GWS_RESPONSE_SHAPE", "Google returned a body that is not JSON", { details: { status: res.status } });
  }
}
