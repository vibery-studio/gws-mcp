// Manual, network-touching step: downloads the public Discovery documents (no credentials) and pins them.
// Run only via `npm run discovery:fetch [api...]`; tests and `gen` never fetch. With api names, only
// those documents are fetched and every other pin (file and pins.json entry) is left untouched.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** One pinned document per `api` (the file stem and pin key). Several apis can back one `service`, like Groups. */
export const DISCOVERY_SOURCES = [
  { api: "gmail", version: "v1", url: "https://gmail.googleapis.com/$discovery/rest?version=v1" },
  { api: "drive", version: "v3", url: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest" },
  { api: "calendar", version: "v3", url: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest" },
  { api: "sheets", version: "v4", url: "https://sheets.googleapis.com/$discovery/rest?version=v4" },
  { api: "docs", version: "v1", url: "https://docs.googleapis.com/$discovery/rest?version=v1" },
  { api: "forms", version: "v1", url: "https://forms.googleapis.com/$discovery/rest?version=v1" },
  { api: "tasks", version: "v1", url: "https://tasks.googleapis.com/$discovery/rest?version=v1" },
  { api: "slides", version: "v1", url: "https://slides.googleapis.com/$discovery/rest?version=v1" },
  { api: "searchconsole", version: "v1", url: "https://searchconsole.googleapis.com/$discovery/rest?version=v1" },
  { api: "analyticsdata", version: "v1beta", url: "https://analyticsdata.googleapis.com/$discovery/rest?version=v1beta" },
  { api: "analyticsadmin", version: "v1beta", url: "https://analyticsadmin.googleapis.com/$discovery/rest?version=v1beta" },
  { api: "admin", version: "directory_v1", url: "https://admin.googleapis.com/$discovery/rest?version=directory_v1" },
  { api: "groupssettings", version: "v1", url: "https://www.googleapis.com/discovery/v1/apis/groupssettings/v1/rest" },
  { api: "googleads", version: "v23", url: "https://googleads.googleapis.com/$discovery/rest?version=v23" },
  { api: "tagmanager", version: "v2", url: "https://tagmanager.googleapis.com/$discovery/rest?version=v2" },
] as const;

type Source = (typeof DISCOVERY_SOURCES)[number];
export interface Pin {
  version: string;
  revision: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** The sources to fetch: all of them, or exactly the named apis. Unknown or repeated names fail. */
export function selectSources(names: readonly string[]): Source[] {
  if (names.length === 0) return [...DISCOVERY_SOURCES];
  const known = new Map<string, Source>(DISCOVERY_SOURCES.map((s) => [s.api, s]));
  const picked = new Set<string>();
  for (const name of names) {
    if (!known.has(name)) throw new Error(`unknown discovery api ${name}; known: ${[...known.keys()].join(", ")}`);
    if (picked.has(name)) throw new Error(`discovery api ${name} given twice`);
    picked.add(name);
  }
  return DISCOVERY_SOURCES.filter((s) => picked.has(s.api));
}

/** Existing pins with the fetched ones replaced or added, in `DISCOVERY_SOURCES` order, so reruns are stable. */
export function mergePins(existing: Readonly<Record<string, Pin>>, fetched: Readonly<Record<string, Pin>>): Record<string, Pin> {
  const merged = { ...existing, ...fetched };
  const order = DISCOVERY_SOURCES.map((s) => s.api as string);
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
    if (!res.ok) throw new Error(`discovery fetch failed for ${src.api}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const doc = JSON.parse(new TextDecoder().decode(bytes)) as { revision?: unknown; version?: unknown };
    if (typeof doc.revision !== "string" || doc.version !== src.version) {
      throw new Error(`unexpected discovery document for ${src.api}`);
    }
    writeFileSync(path.join(dir, `${src.api}.${src.version}.json`), bytes);
    fetched[src.api] = {
      version: src.version,
      revision: doc.revision,
      url: src.url,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    console.log(`${src.api} ${src.version} rev=${doc.revision} bytes=${bytes.length}`);
  }
  writeFileSync(pinsFile, `${JSON.stringify(mergePins(existing, fetched), null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
