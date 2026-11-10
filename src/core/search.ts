import type { Config } from "../config";
import type { Effect, FnMeta } from "../contracts";
import { GwsError } from "../errors";
import { isDestructive } from "./destructive";
import { SYNONYMS } from "./synonyms";

const K1 = 1.2;
const B = 0.75;
const NAME_SEGMENT_BOOST = 2;
const HELPER_BOOST = 0.5;
const DESCRIPTION_CHARS = 300;
const MAX_LIMIT = 10;
const MAX_SIGNATURE_CHARS = 400;
const STOPWORDS = new Set(["a", "an", "and", "by", "for", "in", "is", "of", "on", "or", "the", "to", "with"]);

export interface SearchResult {
  name: string;
  effect: Effect;
  signature: string;
  example: string;
  destructiveHint?: true;
}

export interface FnDetail {
  name: string;
  effect: Effect;
  tsDecl: string;
  scopes: string[];
  example: string;
}

export interface SearchQueryArgs {
  query: string;
  service?: string;
  limit?: number;
}

export interface SearchFnArgs {
  fn: string;
}

interface IndexedFn {
  fn: FnMeta;
  /** Term frequencies over name segments, service, tags and the description head. */
  tf: Map<string, number>;
  length: number;
  nameSegments: Set<string>;
}

interface Index {
  docs: IndexedFn[];
  df: Map<string, number>;
  avgLength: number;
}

const indexes = new WeakMap<readonly FnMeta[], Index>();

/** Lowercases, splits on non-alphanumerics and camelCase, drops stopwords and a trailing plural "s". */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(stem);
}

function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

/** Built lazily and memoized per registry array. Reads only cheap metadata, never `tsDecl`. */
export function buildIndex(fns: readonly FnMeta[]): Index {
  const cached = indexes.get(fns);
  if (cached) return cached;
  const df = new Map<string, number>();
  const docs = fns.map((fn): IndexedFn => {
    const nameSegments = new Set(tokenize(fn.name));
    const tokens = [
      ...tokenize(fn.name),
      ...tokenize(fn.service),
      ...fn.tags.flatMap(tokenize),
      ...tokenize(fn.description.slice(0, DESCRIPTION_CHARS)),
    ];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { fn, tf, length: tokens.length, nameSegments };
  });
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1);
  const index = { docs, df, avgLength };
  indexes.set(fns, index);
  return index;
}

/** Query words, split like the index (camelCase too, so "batchUpdate" matches the name segments "batch update"). */
function expandQuery(query: string): string[] {
  const out = new Set<string>();
  for (const raw of query.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length === 0 || STOPWORDS.has(raw)) continue;
    out.add(stem(raw));
    for (const syn of SYNONYMS[raw] ?? SYNONYMS[stem(raw)] ?? []) out.add(stem(syn));
  }
  return [...out];
}

function score(index: Index, doc: IndexedFn, terms: readonly string[]): number {
  const n = index.docs.length;
  let total = 0;
  for (const term of terms) {
    const f = doc.tf.get(term);
    if (f === undefined) continue;
    const df = index.df.get(term) ?? 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    total += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / index.avgLength));
    if (doc.nameSegments.has(term)) total += NAME_SEGMENT_BOOST;
  }
  return total > 0 && doc.fn.service === "helpers" ? total + HELPER_BOOST : total;
}

function toResult(fn: FnMeta): SearchResult {
  const signature =
    fn.signature.length > MAX_SIGNATURE_CHARS ? `${fn.signature.slice(0, MAX_SIGNATURE_CHARS - 1)}…` : fn.signature;
  const result: SearchResult = { name: fn.name, effect: fn.effect, signature, example: fn.example };
  // Name only: input-dependent cases (public share, ownership transfer) are flagged in the plan at call time.
  if (isDestructive(fn.name).destructive) result.destructiveHint = true;
  return result;
}

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

export function search(args: SearchFnArgs, fns: readonly FnMeta[], config: Pick<Config, "SEARCH_MAX_BYTES">): FnDetail;
export function search(
  args: SearchQueryArgs,
  fns: readonly FnMeta[],
  config: Pick<Config, "SEARCH_MAX_BYTES">,
): SearchResult[];
export function search(
  args: SearchQueryArgs | SearchFnArgs,
  fns: readonly FnMeta[],
  config: Pick<Config, "SEARCH_MAX_BYTES">,
): SearchResult[] | FnDetail {
  if ("fn" in args) {
    const found = fns.find((f) => f.name === args.fn);
    if (!found) throw new GwsError("GWS_UNKNOWN_METHOD", `Unknown method: ${args.fn}`, { fn: args.fn });
    return { name: found.name, effect: found.effect, tsDecl: found.tsDecl, scopes: found.scopes, example: found.example };
  }

  const terms = expandQuery(args.query ?? "");
  if (terms.length === 0) throw new GwsError("GWS_INVALID_INPUT", "search requires a non-empty query or fn");
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? MAX_LIMIT) || MAX_LIMIT, 1), MAX_LIMIT);

  const index = buildIndex(fns);
  const ranked = index.docs
    .filter((d) => args.service === undefined || d.fn.service === args.service)
    .map((d) => ({ fn: d.fn, score: score(index, d, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (a.fn.name < b.fn.name ? -1 : 1))
    .slice(0, limit)
    .map((r) => toResult(r.fn));

  while (ranked.length > 0 && byteLength(ranked) > config.SEARCH_MAX_BYTES) ranked.pop();
  return ranked;
}
