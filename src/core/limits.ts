import type { Config } from "../config";
import type { AuthProps } from "../contracts";
import { GwsError } from "../errors";
import type { RateCounter } from "./ports";

/** Counts SDK calls in one execute; nested helper calls count too. */
export class CallBudget {
  private used = 0;

  constructor(readonly limit: number) {}

  /** Calls refused so far because the budget was spent. */
  get refused(): number {
    return Math.max(0, this.used - this.limit);
  }

  /** Counts one call; throws GWS_CALL_BUDGET_EXCEEDED from call `limit + 1` on. */
  take(): void {
    this.used += 1;
    if (this.used > this.limit) {
      throw new GwsError("GWS_CALL_BUDGET_EXCEEDED", `an execute may make at most ${this.limit} SDK calls`, {
        details: { limit: this.limit },
      });
    }
  }
}

export const RATE_WINDOW_MS = 60_000;

export type RateLimits = Pick<Config, "RATE_USER_PER_MIN" | "RATE_CLIENT_PER_MIN">;

/**
 * Counts one call in two fixed 60 s windows, per user (`u:<userId>`) and per user+client
 * (`c:<userId>:<clientId>`), and throws GWS_RATE_LIMITED when either passes its limit. Refused calls count
 * too, so a client hammering past the limit stays limited for the rest of the window.
 */
export async function checkRate(rate: RateCounter, auth: AuthProps, now: number, limits: RateLimits): Promise<void> {
  const windowStart = now - (now % RATE_WINDOW_MS);
  const [user, client] = await Promise.all([
    rate.hit(`u:${auth.userId}`, windowStart),
    rate.hit(`c:${auth.userId}:${auth.clientId}`, windowStart),
  ]);
  const retryAfterS = Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000));
  const limited = (scope: "user" | "client", limit: number) =>
    new GwsError("GWS_RATE_LIMITED", `rate limit of ${limit} calls per minute per ${scope} reached`, {
      details: { scope, limit, retryAfterS },
    });
  if (user > limits.RATE_USER_PER_MIN) throw limited("user", limits.RATE_USER_PER_MIN);
  if (client > limits.RATE_CLIENT_PER_MIN) throw limited("client", limits.RATE_CLIENT_PER_MIN);
}

/** Per-execute upstream caps; a queued call waits at most `EXECUTE_TIMEOUT_MS` for a slot. */
export type UpstreamConfig = Pick<Config, "EXECUTE_RESPONSE_MAX_BYTES" | "UPSTREAM_CONCURRENCY" | "EXECUTE_TIMEOUT_MS">;

/** UTF-8 length of a string without encoding it (a lone surrogate counts 3, as TextEncoder writes U+FFFD). */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** UTF-8 bytes of the JSON serialization of `value` (0 when it does not serialize). */
export function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : utf8Length(json);
}

/** Throws GWS_RESPONSE_TOO_LARGE when the UTF-8 JSON serialization of `value` is longer than `max` bytes. */
export function capBytes(value: unknown, max: number, scope: "call" | "result" = "call"): void {
  const json = JSON.stringify(value);
  if (json === undefined) return;
  // A UTF-16 unit is at most 3 UTF-8 bytes, so short strings never need measuring.
  if (json.length * 3 <= max) return;
  const bytes = utf8Length(json);
  if (bytes > max) {
    throw new GwsError("GWS_RESPONSE_TOO_LARGE", `the ${scope} result is larger than ${max} bytes`, { details: { scope, bytes, max } });
  }
}

/** Binary data: counted and skipped as a whole, never walked entry by entry. */
export function isBinary(v: object): v is ArrayBuffer | ArrayBufferView {
  return v instanceof ArrayBuffer || ArrayBuffer.isView(v);
}

/**
 * Approximate JSON size in bytes of a value from the sandbox, without serializing it: strings count their
 * UTF-8 bytes, binary data its byte length, other leaves 8, and every array element, key and container its
 * separators. The walk is iterative and stops as soon as the count passes `stopAbove`, so a huge or sparse
 * array, a deep nesting or a multi-MB string costs no more than `stopAbove` steps.
 */
export function approxJsonBytes(value: unknown, stopAbove = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0 && bytes <= stopAbove) {
    const v = stack.pop();
    if (typeof v === "string") {
      // UTF-8 is never shorter than the UTF-16 length: a string that long is over the bound unmeasured.
      bytes += v.length > stopAbove - bytes ? v.length : utf8Length(v) + 2;
    } else if (typeof v !== "object" || v === null) {
      bytes += 8;
    } else if (!seen.has(v)) {
      seen.add(v);
      if (isBinary(v)) {
        bytes += v.byteLength;
      } else if (Array.isArray(v)) {
        bytes += 2 + v.length;
        if (bytes > stopAbove) break;
        for (let i = 0; i < v.length; i++) stack.push(v[i]);
      } else {
        const keys = Object.keys(v);
        bytes += 2 + keys.length;
        for (const k of keys) {
          if (bytes > stopAbove) break;
          bytes += utf8Length(k) + 3;
          stack.push((v as Record<string, unknown>)[k]);
        }
      }
    }
  }
  return bytes;
}

/**
 * Refuses one call's input when its approximate JSON size passes `max`, before anything else walks it.
 * Throws GWS_INVALID_INPUT with reason "input-too-large".
 */
export function checkInputSize(input: unknown, max: number): void {
  if (approxJsonBytes(input, max) > max) {
    throw new GwsError("GWS_INVALID_INPUT", `the input of one SDK call is larger than ${max} bytes`, {
      details: { reason: "input-too-large", max },
    });
  }
}

/** A call waiting for an upstream slot. */
interface Waiter {
  admit(): void;
  fail(e: GwsError): void;
}

/**
 * Per-execute bounds on upstream traffic, so parallel large responses cannot exhaust the isolate's memory
 * (and lose the audit buffer with it): the summed response bytes, and the upstream calls in flight at once.
 * Calls beyond `UPSTREAM_CONCURRENCY` wait in a FIFO queue, since `Promise.all` over ids is a normal snippet
 * pattern. A waiter is released with GWS_EXECUTION_TIMEOUT after `EXECUTE_TIMEOUT_MS`, and with
 * GWS_EXECUTION_ERROR when the session closes. Past the byte budget, GWS_RESPONSE_TOO_LARGE with scope
 * "execute" refuses the call when it is admitted, before anything is sent.
 */
export class UpstreamLimits {
  private bytes = 0;
  /** Slots taken. While a waiter is queued every slot is taken: a freed slot passes straight to the next waiter. */
  private active = 0;
  private readonly queue: Waiter[] = [];
  private closed = false;

  constructor(private readonly limits: UpstreamConfig) {}

  private tooLarge(): GwsError {
    const max = this.limits.EXECUTE_RESPONSE_MAX_BYTES;
    return new GwsError("GWS_RESPONSE_TOO_LARGE", `the upstream responses of this execute are larger than ${max} bytes`, {
      details: { scope: "execute", bytes: this.bytes, max },
    });
  }

  private finished(): GwsError {
    return new GwsError("GWS_EXECUTION_ERROR", "this execute has finished; no more SDK calls are accepted");
  }

  /** Takes a slot, waiting in arrival order when every slot is taken. */
  private acquire(): Promise<void> {
    if (this.active < this.limits.UPSTREAM_CONCURRENCY) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.closed) return Promise.reject(this.finished());
    const limit = this.limits.UPSTREAM_CONCURRENCY;
    const waitMs = this.limits.EXECUTE_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        admit: () => {
          clearTimeout(timer);
          resolve();
        },
        fail: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      timer = setTimeout(() => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(
          new GwsError("GWS_EXECUTION_TIMEOUT", `waited longer than ${waitMs} ms for one of the ${limit} upstream slots of this execute`, {
            details: { scope: "concurrency", limit, waitMs },
          }),
        );
      }, waitMs);
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next.admit();
    else this.active = Math.max(0, this.active - 1);
  }

  /** Runs `fn` holding an upstream slot; refuses it before `fn` runs once the byte budget is spent. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      if (this.bytes >= this.limits.EXECUTE_RESPONSE_MAX_BYTES) throw this.tooLarge();
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Releases every waiter with GWS_EXECUTION_ERROR; later calls that would have to wait are refused. */
  close(): void {
    this.closed = true;
    for (const waiter of this.queue.splice(0)) waiter.fail(this.finished());
  }

  /** Counts a received response; throws when the execute's total passes the budget. */
  spend(value: unknown): void {
    this.bytes += jsonBytes(value);
    if (this.bytes > this.limits.EXECUTE_RESPONSE_MAX_BYTES) throw this.tooLarge();
  }
}
