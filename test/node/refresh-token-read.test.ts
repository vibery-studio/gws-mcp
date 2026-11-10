import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * `getRefreshTokenForRevoke` decrypts a refresh token whatever the account's status. Only the disconnect flow
 * (`revokeAndWipe`) may call it. This compiles src/** with the repo's own options and checks three things.
 *
 * - Every mention of the name (identifier, property declaration, string key) is counted per file. The counts
 *   must match an exact map, so a new property read, destructuring, bracket access or `.call`/`.bind` fails.
 * - The type checker finds every call that invokes the method, directly or through `.call`/`.apply`/`.bind`:
 *   exactly one, inside `revokeAndWipe`.
 * - Nothing reaches a value whose type carries the method dynamically: no computed-key access, spread, or
 *   `Object.*`/`Reflect.*` call over it, since those can read the method without naming it.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const NAME = "getRefreshTokenForRevoke";

/**
 * Where the name may appear, and how often: the port declaration, the D1 method, the Workers and local wiring,
 * the guard.
 */
const EXPECTED_MENTIONS: Readonly<Record<string, number>> = {
  "src/core/accounts-capability.ts": 2, // the `Pick` key of RevokeDeps, and the one call
  "src/core/ports.ts": 1, // AccountStore's declaration
  "src/local/ports.ts": 2, // `getRefreshTokenForRevoke: accounts.getRefreshTokenForRevoke`, by reference like Workers
  "src/runtime/workers/ports.ts": 2, // `getRefreshTokenForRevoke: accounts.getRefreshTokenForRevoke`
  "src/store/db.ts": 1, // the D1 method
};

function rel(abs: string): string {
  return path.relative(ROOT, abs).split(path.sep).join("/");
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(child));
    else if (entry.name.endsWith(".ts")) out.push(path.join(ROOT, child));
  }
  return out;
}

/** A program over src/** (and the Worker types it compiles against), with the repo's tsconfig options. */
function srcProgram(probes: Readonly<Record<string, string>> = {}): ts.Program {
  const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const host = ts.createCompilerHost(parsed.options, true);
  const virtual = new Map(Object.entries(probes).map(([f, text]) => [path.join(ROOT, f), text]));
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => virtual.has(path.normalize(f)) || fileExists.call(host, f);
  host.readFile = (f) => virtual.get(path.normalize(f)) ?? readFile.call(host, f);
  host.getSourceFile = (f, language, onError, shouldCreate) => {
    const text = virtual.get(path.normalize(f));
    if (text !== undefined) return ts.createSourceFile(f, text, language, true);
    // An overridden file (a probe replacing a real one) is read from `virtual` above.
    return getSourceFile.call(host, f, language, onError, shouldCreate);
  };
  const roots = [...new Set([...tsFilesUnder("src"), path.join(ROOT, "worker-configuration.d.ts"), ...virtual.keys()])];
  return ts.createProgram(roots, parsed.options, host);
}

/** True when a value of type `t` (or any member of a union) has the token-read method as a property. */
function carriesMethod(checker: ts.TypeChecker, t: ts.Type): boolean {
  const parts = t.isUnion() || t.isIntersection() ? t.types : [t];
  return parts.some((p) => checker.getPropertyOfType(checker.getApparentType(p), NAME) !== undefined);
}

function isNamedSymbol(checker: ts.TypeChecker, node: ts.Node): boolean {
  const sym = checker.getSymbolAtLocation(node);
  return sym?.getName() === NAME;
}

/** The node that names the invoked function of a call, unwrapping `x.m.call(…)`, `x.m.apply(…)`, `x.m.bind(…)(…)`. */
function invokedName(call: ts.CallExpression): ts.Node | undefined {
  let callee: ts.Expression = call.expression;
  if (ts.isCallExpression(callee)) callee = callee.expression; // `x.m.bind(t)(…)`
  while (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee) || ts.isAsExpression(callee)) callee = callee.expression;
  const member = (e: ts.Expression) =>
    ts.isPropertyAccessExpression(e) ? e.name : ts.isElementAccessExpression(e) ? e.argumentExpression : undefined;
  const last = member(callee);
  if (last && ts.isIdentifier(last) && ["call", "apply", "bind"].includes(last.text) && ts.isPropertyAccessExpression(callee)) {
    return member(callee.expression) ?? callee.expression;
  }
  return last ?? callee;
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name)) return n.name.text;
  }
  return undefined;
}

interface Findings {
  mentions: Record<string, number>;
  calls: string[];
  dynamic: string[];
}

function scan(program: ts.Program): Findings {
  const checker = program.getTypeChecker();
  const mentions: Record<string, number> = {};
  const calls: string[] = [];
  const dynamic: string[] = [];
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (!file.startsWith("src/")) continue;
    const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const visit = (node: ts.Node): void => {
      if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === NAME) {
        mentions[file] = (mentions[file] ?? 0) + 1;
      }
      if (ts.isCallExpression(node)) {
        const named = invokedName(node);
        if (named && isNamedSymbol(checker, named)) calls.push(`${at(node)} in ${enclosingFunctionName(node) ?? "(top level)"}`);
      }
      const typed = (e: ts.Expression) => carriesMethod(checker, checker.getTypeAtLocation(e));
      if (ts.isElementAccessExpression(node) && !ts.isStringLiteralLike(node.argumentExpression) && !ts.isNumericLiteral(node.argumentExpression)) {
        if (typed(node.expression)) dynamic.push(`${at(node)}: a computed key on a value carrying ${NAME}`);
      } else if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && typed(node.expression)) {
        dynamic.push(`${at(node)}: a spread of a value carrying ${NAME}`);
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const owner = node.expression.expression;
        if (ts.isIdentifier(owner) && (owner.text === "Object" || owner.text === "Reflect") && node.arguments.some(typed)) {
          dynamic.push(`${at(node)}: ${owner.text}.${node.expression.name.text} over a value carrying ${NAME}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { mentions, calls, dynamic };
}

describe("the status-blind refresh-token read", () => {
  const findings = scan(srcProgram());

  it("is named only where it is declared, wired and called", () => {
    expect(findings.mentions).toEqual(EXPECTED_MENTIONS);
  });

  it("is called exactly once, by the disconnect flow", () => {
    expect(findings.calls).toEqual([expect.stringMatching(/^src\/core\/accounts-capability\.ts:\d+ in revokeAndWipe$/)]);
  });

  it("is never reached through a computed key, a spread or Object/Reflect", () => {
    expect(findings.dynamic).toEqual([]);
  });

  it("catches a property read, a bracket .call and dynamic forms elsewhere", () => {
    const probe = scan(
      srcProgram({
        "src/core/__probe_read.ts": [
          'import type { AccountStore, SessionPorts } from "./ports";',
          `export const a = (p: SessionPorts) => p.accounts.${NAME};`,
          `export const b = (p: SessionPorts) => p.accounts["${NAME}"].call(null, "u", "a");`,
          "export const c = (s: AccountStore, k: keyof AccountStore) => s[k];",
          "export const d = (s: AccountStore) => ({ ...s });",
          "export const e = (s: AccountStore) => Object.values(s);",
        ].join("\n"),
      }),
    );
    expect(probe.mentions["src/core/__probe_read.ts"]).toBe(2);
    expect(probe.calls.filter((c) => c.startsWith("src/core/__probe_read.ts"))).toHaveLength(1);
    expect(probe.dynamic.filter((d) => d.startsWith("src/core/__probe_read.ts"))).toHaveLength(3);
  }, 120_000);
});
