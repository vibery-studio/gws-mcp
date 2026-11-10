import type { DiscoveryParam, DiscoverySchema } from "./types";

/** A Discovery shape the emitter cannot map safely. Callers turn it into an unsupported-method entry. */
export class UnsupportedShape extends Error {}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const lit = (value: string | number | boolean): string => JSON.stringify(value);

export const propKey = (name: string): string => {
  if (name === "__proto__") throw new UnsupportedShape("property named __proto__");
  return IDENT.test(name) ? name : JSON.stringify(name);
};

export const schemaAccess = (name: string): string =>
  IDENT.test(name) ? `schemas.${name}` : `schemas[${JSON.stringify(name)}]`;

/** Byte-order comparison; never locale dependent. */
export const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const is64Bit = (format: string | undefined): boolean => format === "int64" || format === "uint64";

/**
 * Zod expression for a schema node. Objects are loose with every property optional and enums are plain
 * strings, so responses keep validating when Google adds fields or enum values.
 */
export function zodSchema(node: DiscoverySchema): string {
  if (node.$ref !== undefined) return `z.lazy(() => ${schemaAccess(node.$ref)}())`;
  switch (node.type) {
    case "string":
      return "z.string()";
    case "integer":
      return "z.number().int()";
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "any":
      return "z.unknown()";
    case "array":
      if (node.items === undefined) throw new UnsupportedShape("array without items");
      return `z.array(${zodSchema(node.items)})`;
    case "object": {
      const props = node.properties;
      const extra = node.additionalProperties;
      if (props !== undefined && extra !== undefined) {
        throw new UnsupportedShape("object with both properties and additionalProperties");
      }
      if (extra !== undefined) return `z.record(z.string(), ${zodSchema(extra)})`;
      const names = Object.keys(props ?? {}).sort(byteOrder);
      if (names.length === 0) return "z.looseObject({})";
      const fields = names.map((n) => `${propKey(n)}: ${zodSchema(props![n]!)}.optional()`);
      return `z.looseObject({ ${fields.join(", ")} })`;
    }
    default:
      throw new UnsupportedShape(`unmapped type ${node.type ?? "(none)"}`);
  }
}

/** Zod expression for a method parameter: enums stay strict, defaults are applied, 64-bit ints are strings. */
export function zodParam(name: string, p: DiscoveryParam): string {
  let base: string;
  switch (p.type) {
    case "string":
      base = p.enum !== undefined ? `z.enum([${p.enum.map(lit).join(", ")}])` : "z.string()";
      break;
    case "integer": {
      base = is64Bit(p.format) ? "z.string()" : "z.number().int()";
      if (p.minimum !== undefined && !Number.isNaN(Number(p.minimum))) base += `.min(${Number(p.minimum)})`;
      if (p.maximum !== undefined && !Number.isNaN(Number(p.maximum))) base += `.max(${Number(p.maximum)})`;
      break;
    }
    case "number":
      base = "z.number()";
      break;
    case "boolean":
      base = "z.boolean()";
      break;
    default:
      throw new UnsupportedShape(`parameter ${name}: unmapped type ${p.type ?? "(none)"}`);
  }
  if (p.repeated === true) base = `z.array(${base})`;
  if (p.required === true) return base;
  if (p.default !== undefined && p.repeated !== true) return `${base}.default(${paramDefault(name, p)})`;
  return `${base}.optional()`;
}

function paramDefault(name: string, p: DiscoveryParam): string {
  const raw = p.default as string;
  switch (p.type) {
    case "boolean":
      if (raw !== "true" && raw !== "false") throw new UnsupportedShape(`parameter ${name}: bad boolean default`);
      return raw;
    case "integer":
      if (is64Bit(p.format)) return lit(raw);
      if (Number.isNaN(Number(raw))) throw new UnsupportedShape(`parameter ${name}: bad integer default`);
      return String(Number(raw));
    case "number":
      if (Number.isNaN(Number(raw))) throw new UnsupportedShape(`parameter ${name}: bad number default`);
      return String(Number(raw));
    default:
      if (p.enum !== undefined && !p.enum.includes(raw)) {
        throw new UnsupportedShape(`parameter ${name}: default outside enum`);
      }
      return lit(raw);
  }
}

const unionOf = (values: string[]): string => values.map(lit).join(" | ");
const wrapUnion = (t: string): string => (t.includes(" | ") ? `(${t})` : t);

/** TypeScript type text for a schema node. Named schemas are referenced by name. */
export function tsType(node: DiscoverySchema, opts: { enumLimit?: number } = {}): string {
  if (node.$ref !== undefined) return node.$ref;
  switch (node.type) {
    case "string":
      if (node.enum !== undefined && node.enum.length > 0 && node.enum.length <= (opts.enumLimit ?? Infinity)) {
        return unionOf(node.enum);
      }
      return "string";
    case "integer":
      return is64Bit(node.format) ? "string" : "number";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "any":
      return "unknown";
    case "array":
      if (node.items === undefined) throw new UnsupportedShape("array without items");
      return `${wrapUnion(tsType(node.items, opts))}[]`;
    case "object": {
      if (node.additionalProperties !== undefined) return `{ [key: string]: ${tsType(node.additionalProperties, opts)} }`;
      const names = Object.keys(node.properties ?? {}).sort(byteOrder);
      if (names.length === 0) return "{ [key: string]: unknown }";
      return `{ ${names.map((n) => `${propKey(n)}?: ${tsType(node.properties![n]!, opts)};`).join(" ")} }`;
    }
    default:
      throw new UnsupportedShape(`unmapped type ${node.type ?? "(none)"}`);
  }
}

/** TypeScript declaration for a named schema. */
export function tsDeclaration(name: string, node: DiscoverySchema): string {
  if (node.type === "object" && node.additionalProperties === undefined) {
    const names = Object.keys(node.properties ?? {}).sort(byteOrder);
    if (names.length === 0) return `interface ${name} { [key: string]: unknown }`;
    const lines = names.map((n) => `  ${propKey(n)}?: ${tsType(node.properties![n]!)};`);
    return `interface ${name} {\n${lines.join("\n")}\n}`;
  }
  return `type ${name} = ${tsType(node)};`;
}

/** Names of schemas referenced anywhere inside a node. */
export function refsOf(node: DiscoverySchema, into: Set<string> = new Set()): Set<string> {
  if (node.$ref !== undefined) into.add(node.$ref);
  if (node.items !== undefined) refsOf(node.items, into);
  if (node.additionalProperties !== undefined) refsOf(node.additionalProperties, into);
  for (const p of Object.values(node.properties ?? {})) refsOf(p, into);
  return into;
}
