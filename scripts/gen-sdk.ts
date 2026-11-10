// Generates src/sdk/generated/** from the pinned Discovery documents. Never touches the network.
//   npm run gen         write the files
//   npm run gen:check   fail (exit 1) unless the committed files are byte-identical to a fresh generation
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GOOGLE_SERVICES } from "../src/config";
import { generate, type GenerateInput } from "./gen/generate";
import type { DiscoveryDoc } from "./gen/types";

interface Pin {
  version: string;
  revision: string;
  url: string;
  sha256: string;
  bytes: number;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src/sdk/generated");

function fail(message: string): never {
  console.error(`sdk: ${message}`);
  process.exit(1);
}

/** Loads the pinned documents, failing loudly when a file no longer matches its recorded hash. */
function loadPinned(): GenerateInput {
  const pins = JSON.parse(readFileSync(path.join(root, "discovery/pins.json"), "utf8")) as Record<string, Pin>;
  const input: GenerateInput = {};
  for (const service of GOOGLE_SERVICES) {
    const pin = pins[service];
    if (pin === undefined) fail(`discovery/pins.json has no entry for ${service}`);
    const file = `discovery/${service}.${pin.version}.json`;
    const bytes = readFileSync(path.join(root, file));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== pin.sha256 || bytes.length !== pin.bytes) {
      fail(`pin drift in ${file}: expected sha256 ${pin.sha256}, found ${actual}`);
    }
    const doc = JSON.parse(bytes.toString("utf8")) as DiscoveryDoc;
    if (doc.revision !== pin.revision || doc.version !== pin.version) {
      fail(`pin mismatch in ${file}: document is ${doc.version}@${doc.revision}, pins say ${pin.version}@${pin.revision}`);
    }
    input[service] = { doc, version: pin.version, revision: pin.revision };
  }
  return input;
}

const result = generate(loadPinned());
const summary = `files=${result.files.size} methods=${result.supported}/${result.total}`;

if (process.argv.includes("--check")) {
  const onDisk = new Set(readdirSync(outDir).filter((f) => f.endsWith(".ts") || f.endsWith(".md")));
  for (const [file, text] of result.files) {
    let current: string;
    try {
      current = readFileSync(path.join(outDir, file), "utf8");
    } catch {
      fail(`differs: src/sdk/generated/${file} is missing`);
    }
    if (current !== text) fail(`differs: src/sdk/generated/${file}`);
    onDisk.delete(file);
  }
  const extra = [...onDisk].sort()[0];
  if (extra !== undefined) fail(`differs: unexpected file src/sdk/generated/${extra}`);
  console.log(`sdk: byte-identical ${result.hash} ${summary}`);
} else {
  mkdirSync(outDir, { recursive: true });
  for (const [file, text] of result.files) writeFileSync(path.join(outDir, file), text);
  console.log(`sdk: wrote ${result.hash} ${summary} unsupported=${result.unsupported.length}`);
}
