// Manual, network-touching step: downloads the public Discovery documents (no credentials) and pins them.
// Run only via `npm run discovery:fetch [service...]`; tests and `gen` never fetch. With service names, only
// those documents are fetched and every other pin (file and pins.json entry) is left untouched.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DISCOVERY_SOURCES = [
  { service: "gmail", version: "v1", url: "https://gmail.googleapis.com/$discovery/rest?version=v1" },
  { service: "drive", version: "v3", url: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest" },
  { service: "calendar", version: "v3", url: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest" },
  { service: "sheets", version: "v4", url: "https://sheets.googleapis.com/$discovery/rest?version=v4" },
  { service: "docs", version: "v1", url: "https://docs.googleapis.com/$discovery/rest?version=v1" },
  { service: "forms", version: "v1", url: "https://forms.googleapis.com/$discovery/rest?version=v1" },
  { service: "tasks", version: "v1", url: "https://tasks.googleapis.com/$discovery/rest?version=v1" },
  { service: "slides", version: "v1", url: "https://slides.googleapis.com/$discovery/rest?version=v1" },
] as const;

type Source = (typeof DISCOVERY_SOURCES)[number];
export interface Pin {
  version: string;
  revision: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** The sources to fetch: all of them, or exactly the named services. Unknown or repeated names fail. */
export function selectSources(names: readonly string[]): Source[] {
  if (names.length === 0) return [...DISCOVERY_SOURCES];
  const known = new Map<string, Source>(DISCOVERY_SOURCES.map((s) => [s.service, s]));
  const picked = new Set<string>();
  for (const name of names) {
    if (!known.has(name)) throw new Error(`unknown discovery service ${name}; known: ${[...known.keys()].join(", ")}`);
    if (picked.has(name)) throw new Error(`discovery service ${name} given twice`);
    picked.add(name);
  }
  return DISCOVERY_SOURCES.filter((s) => picked.has(s.service));
}

/** Existing pins with the fetched ones replaced or added, in `DISCOVERY_SOURCES` order, so reruns are stable. */
export function mergePins(existing: Readonly<Record<string, Pin>>, fetched: Readonly<Record<string, Pin>>): Record<string, Pin> {
  const merged = { ...existing, ...fetched };
  const order = DISCOVERY_SOURCES.map((s) => s.service as string);
  const unknown = Object.keys(merged).filter((k) => !order.includes(k));
  if (unknown.length > 0) throw new Error(`pins.json has entries without a discovery source: ${unknown.join(", ")}`);
  return Object.fromEntries(order.filter((k) => merged[k] !== undefined).map((k) => [k, merged[k]!]));
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = path.join(root, "discovery");
  const pinsFile = path.join(dir, "pins.json");
  mkdirSync(dir, { recursive: true });
  const sources = selectSources(process.argv.slice(2));
  const existing = existsSync(pinsFile) ? (JSON.parse(readFileSync(pinsFile, "utf8")) as Record<string, Pin>) : {};
  const fetched: Record<string, Pin> = {};
  for (const src of sources) {
    const res = await fetch(src.url);
    if (!res.ok) throw new Error(`discovery fetch failed for ${src.service}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const doc = JSON.parse(new TextDecoder().decode(bytes)) as { revision?: unknown; version?: unknown };
    if (typeof doc.revision !== "string" || doc.version !== src.version) {
      throw new Error(`unexpected discovery document for ${src.service}`);
    }
    writeFileSync(path.join(dir, `${src.service}.${src.version}.json`), bytes);
    fetched[src.service] = {
      version: src.version,
      revision: doc.revision,
      url: src.url,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    console.log(`${src.service} ${src.version} rev=${doc.revision} bytes=${bytes.length}`);
  }
  writeFileSync(pinsFile, `${JSON.stringify(mergePins(existing, fetched), null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
