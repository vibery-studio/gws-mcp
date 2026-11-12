import { googleError } from "../oauth";

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The body as a JSON object; `{}` when empty; undefined when it is not valid JSON or not an object. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | undefined> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function badRequest(message: string, reason = "badRequest"): Response {
  return googleError(400, message, "INVALID_ARGUMENT", { errors: [{ message, domain: "global", reason }] });
}

export function notFound(message = "Requested entity was not found."): Response {
  return googleError(404, message, "NOT_FOUND", { errors: [{ message, domain: "global", reason: "notFound" }] });
}

export function forbidden(message: string, reason = "forbidden"): Response {
  return googleError(403, message, "PERMISSION_DENIED", { errors: [{ message, domain: "global", reason }] });
}

export function conflict(message: string, reason = "duplicate"): Response {
  return googleError(409, message, "ALREADY_EXISTS", { errors: [{ message, domain: "global", reason }] });
}

export const noContent = (): Response => new Response(null, { status: 204 });

/** A non-negative integer query parameter; `fallback` when absent. Returns a message when malformed. */
export function intParam(p: URLSearchParams, name: string, fallback: number): number | string {
  const raw = p.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d{1,9}$/.test(raw)) return `Invalid value at '${name}': "${raw}"`;
  return Number(raw);
}

/** A page of `all` using a numeric offset token, the way the fakes page every list. */
export function paginate<T>(
  all: T[],
  p: URLSearchParams,
  sizeParam: string,
  defaultSize: number,
  maxSize: number,
): { page: T[]; nextPageToken?: string } | { error: string } {
  const size = intParam(p, sizeParam, defaultSize);
  if (typeof size === "string") return { error: size };
  const offset = intParam(p, "pageToken", 0);
  if (typeof offset === "string") return { error: "Invalid pageToken." };
  const take = Math.min(size === 0 ? defaultSize : size, maxSize);
  const page = all.slice(offset, offset + take);
  return offset + page.length < all.length ? { page, nextPageToken: String(offset + page.length) } : { page };
}

/** Digits only, `length` of them: stands in for the numeric ids Google issues. */
export function randomDigits(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b, i) => String(i === 0 ? 1 + (b % 9) : b % 10)).join("");
}

/** `YYYY-MM-DD` of an epoch-ms instant (UTC). */
export const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
