/**
 * A small parser for the GAQL subset the fake serves:
 * `SELECT f1, f2 FROM resource [WHERE cond AND cond] [ORDER BY f [ASC|DESC], ...] [LIMIT n]`.
 * It knows nothing about which fields exist; the evaluator in ads.ts checks that.
 */

export type GaqlValue = string | number;

export type GaqlOperator = "=" | "!=" | "<" | "<=" | ">" | ">=" | "IN" | "NOT IN" | "LIKE" | "NOT LIKE" | "BETWEEN" | "DURING";

export interface GaqlCondition {
  field: string;
  op: GaqlOperator;
  /** A list for IN / NOT IN, two values for BETWEEN, one otherwise. Bare words (enums) are strings. */
  value: GaqlValue | GaqlValue[];
}

export interface GaqlQuery {
  select: string[];
  from: string;
  where: GaqlCondition[];
  orderBy: Array<{ field: string; desc: boolean }>;
  limit?: number;
}

/** Google's `QueryError` enum names, so the caller can answer with the shape Google uses. */
export type GaqlErrorCode =
  | "UNEXPECTED_END_OF_QUERY"
  | "UNEXPECTED_INPUT"
  | "BAD_VALUE"
  | "BAD_LITERAL_VALUE"
  | "UNSUPPORTED_CLAUSE"
  | "UNRECOGNIZED_FIELD"
  | "PROHIBITED_RESOURCE_TYPE_IN_FROM_CLAUSE"
  | "PROHIBITED_FIELD_IN_SELECT_CLAUSE"
  | "PROHIBITED_FIELD_IN_WHERE_CLAUSE"
  | "PROHIBITED_FIELD_IN_ORDER_BY_CLAUSE"
  | "INVALID_DATE"
  | "INVALID_LIMIT_CLAUSE";

export class GaqlError extends Error {
  constructor(
    readonly code: GaqlErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Token = { kind: "word" | "number" | "string" | "symbol"; text: string };

const TOKEN_RE = /\s*(?:(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(<=|>=|!=|<>|[=<>,()]))/y;

function tokenize(query: string): Token[] {
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let pos = 0;
  while (pos < query.length) {
    if (/^\s*$/.test(query.slice(pos))) break;
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(query);
    if (!m) throw new GaqlError("UNEXPECTED_INPUT", `Error in query: unexpected input at '${query.slice(pos).trim().slice(0, 20)}'.`);
    pos = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) out.push({ kind: "number", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "word", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "string", text: m[3].replace(/\\(.)/g, "$1") });
    else if (m[4] !== undefined) out.push({ kind: "string", text: m[4].replace(/\\(.)/g, "$1") });
    else out.push({ kind: "symbol", text: m[5] === "<>" ? "!=" : (m[5] as string) });
  }
  return out;
}

const CLAUSES = new Set(["SELECT", "FROM", "WHERE", "ORDER", "LIMIT", "PARAMETERS"]);

class Cursor {
  #i = 0;
  constructor(private readonly tokens: Token[]) {}

  get done(): boolean {
    return this.#i >= this.tokens.length;
  }

  peek(): Token | undefined {
    return this.tokens[this.#i];
  }

  /** True when the next token is the (case-insensitive) keyword. */
  atWord(word: string): boolean {
    const t = this.peek();
    return t?.kind === "word" && t.text.toUpperCase() === word;
  }

  atSymbol(symbol: string): boolean {
    const t = this.peek();
    return t?.kind === "symbol" && t.text === symbol;
  }

  next(what: string): Token {
    const t = this.tokens[this.#i++];
    if (!t) throw new GaqlError("UNEXPECTED_END_OF_QUERY", `Error in query: unexpected end of query, expected ${what}.`);
    return t;
  }

  expectWord(word: string): void {
    const t = this.next(word);
    if (t.kind !== "word" || t.text.toUpperCase() !== word) {
      throw new GaqlError("UNEXPECTED_INPUT", `Error in query: unexpected input '${t.text}', expected ${word}.`);
    }
  }

  field(): string {
    const t = this.next("a field name");
    if (t.kind !== "word" || CLAUSES.has(t.text.toUpperCase())) {
      throw new GaqlError("UNEXPECTED_INPUT", `Error in query: unexpected input '${t.text}', expected a field name.`);
    }
    return t.text;
  }
}

function literal(c: Cursor): GaqlValue {
  const t = c.next("a value");
  if (t.kind === "number") return Number(t.text);
  if (t.kind === "string" || t.kind === "word") return t.text;
  throw new GaqlError("BAD_VALUE", `Error in query: unexpected input '${t.text}', expected a value.`);
}

function condition(c: Cursor): GaqlCondition {
  const field = c.field();
  const t = c.next("an operator");
  let op: GaqlOperator;
  if (t.kind === "symbol" && ["=", "!=", "<", "<=", ">", ">="].includes(t.text)) op = t.text as GaqlOperator;
  else if (t.kind === "word") {
    const w = t.text.toUpperCase();
    if (w === "NOT") {
      const n = c.next("IN or LIKE");
      const nw = n.text.toUpperCase();
      if (nw !== "IN" && nw !== "LIKE") throw new GaqlError("UNEXPECTED_INPUT", `Error in query: unexpected input '${n.text}'.`);
      op = nw === "IN" ? "NOT IN" : "NOT LIKE";
    } else if (w === "IN" || w === "LIKE" || w === "BETWEEN" || w === "DURING") op = w;
    else throw new GaqlError("UNEXPECTED_INPUT", `Error in query: unexpected input '${t.text}', expected an operator.`);
  } else throw new GaqlError("UNEXPECTED_INPUT", `Error in query: unexpected input '${t.text}', expected an operator.`);

  if (op === "IN" || op === "NOT IN") {
    if (!c.atSymbol("(")) throw new GaqlError("UNEXPECTED_INPUT", "Error in query: IN needs a parenthesised list.");
    c.next("(");
    const values: GaqlValue[] = [literal(c)];
    while (c.atSymbol(",")) {
      c.next(",");
      values.push(literal(c));
    }
    const close = c.next(")");
    if (close.text !== ")") throw new GaqlError("UNEXPECTED_INPUT", `Error in query: unexpected input '${close.text}', expected ')'.`);
    return { field, op, value: values };
  }
  if (op === "BETWEEN") {
    const low = literal(c);
    c.expectWord("AND");
    return { field, op, value: [low, literal(c)] };
  }
  return { field, op, value: literal(c) };
}

/** Parses `query`, or throws a GaqlError. Keywords are case-insensitive; field names are not. */
export function parseGaql(query: string): GaqlQuery {
  const c = new Cursor(tokenize(query));
  c.expectWord("SELECT");
  const select = [c.field()];
  while (c.atSymbol(",")) {
    c.next(",");
    select.push(c.field());
  }
  c.expectWord("FROM");
  const from = c.field();

  const where: GaqlCondition[] = [];
  if (c.atWord("WHERE")) {
    c.next("WHERE");
    where.push(condition(c));
    while (c.atWord("AND")) {
      c.next("AND");
      where.push(condition(c));
    }
    if (c.atWord("OR")) throw new GaqlError("UNSUPPORTED_CLAUSE", "Error in query: OR is not supported in WHERE.");
  }

  const orderBy: GaqlQuery["orderBy"] = [];
  if (c.atWord("ORDER")) {
    c.next("ORDER");
    c.expectWord("BY");
    do {
      if (orderBy.length > 0) c.next(",");
      const field = c.field();
      const desc = c.atWord("DESC");
      if (desc || c.atWord("ASC")) c.next("ASC or DESC");
      orderBy.push({ field, desc });
    } while (c.atSymbol(","));
  }

  let limit: number | undefined;
  if (c.atWord("LIMIT")) {
    c.next("LIMIT");
    const t = c.next("a number");
    if (t.kind !== "number" || !/^\d+$/.test(t.text) || Number(t.text) < 1) {
      throw new GaqlError("INVALID_LIMIT_CLAUSE", "Error in query: LIMIT must be a positive integer.");
    }
    limit = Number(t.text);
  }

  if (c.atWord("PARAMETERS")) throw new GaqlError("UNSUPPORTED_CLAUSE", "Error in query: the fake does not support PARAMETERS.");
  const rest = c.peek();
  if (rest) throw new GaqlError("UNEXPECTED_INPUT", `Error in query: unexpected input '${rest.text}'.`);
  return { select, from, where, orderBy, ...(limit === undefined ? {} : { limit }) };
}
