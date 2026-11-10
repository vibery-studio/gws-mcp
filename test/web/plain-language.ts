import { connectAppHelp } from "../../src/web/copy";

/**
 * Plain-language check for rendered pages: the visible UI text must not use technical terms.
 *
 * Visible text is every HTML text node (including `<title>`), plus the attributes a user reads or hears:
 * `title`, `alt`, `placeholder`, the text-valued `aria-*` attributes, and the `value` of submit, reset and
 * button inputs. Never checked: `<style>` and `<script>` contents, comments, id-reference `aria-*` attributes
 * (`aria-labelledby` and the like) and hidden-input values.
 *
 * Nothing is exempt by markup alone:
 * - The help block (an element with `data-help`, the one place the connector address may appear) is skipped
 *   only because its whole text is pinned: a page may hold at most one, and its text must equal the fixed
 *   connection help for the page's connector address.
 * - A mono element (class `mono`) is skipped only when its whole text is an email address or a generated id;
 *   any other mono text is checked like the rest of the page.
 * - Known user values (emails, account names, AI app names) are listed explicitly in `allow` and removed from
 *   the text before matching, as whole words only, so a page never needs markup to hide user data from the
 *   check and a short value cannot hide a banned word it is part of.
 *
 * A term matches as a whole word in any case, with an optional English ending (s, es, d, ed, ing). Hyphens
 * join words, so the product name "gws-mcp" is one word and passes, while "MCP" or "/mcp" fail.
 */

export const BANNED_TERMS = ["oauth", "scope", "client", "grant", "token", "alias", "revoke", "mcp"] as const;

export interface PlainLanguageOptions {
  /** Known user values shown on the page (emails, account names, AI app names); removed before matching. */
  allow?: readonly string[];
  /** The connector address the page's help block names. Required when the page has a help block. */
  connectorUrl?: string;
}

/** Word edges: hyphens and underscores join words, so neither side may be a letter, digit, "_" or "-". */
const WORD_EDGE_BEFORE = "(?<![\\p{L}\\p{N}_-])";
const WORD_EDGE_AFTER = "(?![\\p{L}\\p{N}_-])";
const TERM_RE = new RegExp(`${WORD_EDGE_BEFORE}(${BANNED_TERMS.join("|")})(?:s|es|d|ed|ing)?${WORD_EDGE_AFTER}`, "giu");

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["style", "script"]);
const TEXT_ARIA = new Set(["aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "aria-placeholder", "aria-braillelabel"]);
const BUTTON_INPUTS = new Set(["submit", "reset", "button"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** An email address: one "@", no spaces, a dotted domain. */
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>.]+$/;
/** A generated id: one run of id characters, at least eight long and holding a digit (no word qualifies). */
const ID_RE = /^(?=[^\s]*\d)[A-Za-z0-9][A-Za-z0-9_.:-]{7,255}$/;

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function attributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of source.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs.set((m[1] ?? "").toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return attrs;
}

/** Whether mono text is an email or a generated id, the only mono text the check skips. */
export function isEmailOrId(text: string): boolean {
  const t = collapse(text);
  return EMAIL_RE.test(t) || ID_RE.test(t);
}

interface Frame {
  tag: string;
  /** Set on a help block's own element: its collected text. */
  help?: string[];
  /** Set on the outermost mono element: its collected text. */
  mono?: string[];
}

interface Scan {
  /** The strings the check reads, in document order (a mono element's text once it closes). */
  visible: string[];
  /** The whole text of each help block. */
  help: string[];
}

function scan(html: string): Scan {
  const visible: string[] = [];
  const help: string[] = [];
  const stack: Frame[] = [];
  const helpFrame = () => stack.find((f) => f.help !== undefined);
  const monoFrame = () => stack.find((f) => f.mono !== undefined);

  /** Text inside a help block goes to it; inside mono, to the mono element; else it is visible. */
  const emit = (text: string) => {
    const target = helpFrame()?.help ?? monoFrame()?.mono ?? visible;
    target.push(text);
  };

  const close = (frame: Frame) => {
    if (frame.help) help.push(collapse(frame.help.join(" ")));
    if (frame.mono) {
      const text = collapse(frame.mono.join(" "));
      if (text && !isEmailOrId(text)) emit(text);
    }
  };

  const token = /<!--[\s\S]*?-->|<![^>]*>|<\/\s*([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html)) !== null) {
    const [whole, closing, opening, attrSource, text] = m;
    if (text !== undefined) {
      const t = collapse(decode(text));
      if (t) emit(t);
    } else if (closing !== undefined) {
      const tag = closing.toLowerCase();
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at >= 0) for (const frame of stack.splice(at).reverse()) close(frame);
    } else if (opening !== undefined) {
      const tag = opening.toLowerCase();
      const attrs = attributes(attrSource ?? "");
      for (const [name, value] of attrs) {
        const shown =
          name === "title" || name === "alt" || name === "placeholder" || TEXT_ARIA.has(name) || (name === "value" && tag === "input" && BUTTON_INPUTS.has(attrs.get("type") ?? ""));
        if (!shown || !value.trim()) continue;
        // An attribute is never skipped as mono text: inside a help block it counts toward its text, else it is visible.
        (helpFrame()?.help ?? visible).push(collapse(value));
      }
      if (RAW_TEXT.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}`, token.lastIndex);
        token.lastIndex = end < 0 ? html.length : end;
        continue;
      }
      const isHelp = attrs.has("data-help");
      const isMono = (attrs.get("class") ?? "").split(/\s+/).includes("mono");
      const frame: Frame = { tag };
      if (isHelp) {
        // A nested help block still counts as one more block (and fails the one-block rule).
        if (helpFrame()) help.push("");
        else frame.help = [];
      } else if (isMono && !monoFrame() && !helpFrame()) {
        frame.mono = [];
      }
      if (VOID.has(tag) || whole.endsWith("/>")) close(frame);
      else stack.push(frame);
    }
  }
  for (const frame of stack.splice(0).reverse()) close(frame);
  return { visible, help };
}

/** The strings of `html` the check reads, in document order: everything but the help block and email or id mono text. */
export function visibleText(html: string): string[] {
  return scan(html).visible;
}

/** The whole text of each help block in `html`. */
export function helpBlockTexts(html: string): string[] {
  return scan(html).help;
}

/** The fixed text of the connection help for `connectorUrl`, as the help block shows it. */
export function expectedHelpText(connectorUrl: string): string {
  const help = connectAppHelp(connectorUrl);
  return collapse([help.title, ...help.steps].join(" "));
}

/** The banned terms in one string, as written. */
export function bannedTermsInText(text: string): string[] {
  return [...text.matchAll(TERM_RE)].map((m) => m[0]);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * `text` with every whole-word occurrence of each allowed value replaced by a space (longest first). A value
 * counts only where the banned-term rule would see a word edge, so a short value (say "ok") never removes
 * part of a longer word ("token") and hides it from the check.
 */
function withoutAllowed(text: string, allow: readonly string[]): string {
  const values = [...new Set(allow.map(collapse).filter((v) => v.length > 0))].sort((a, b) => b.length - a.length);
  return values.reduce((t, v) => t.replace(new RegExp(`${WORD_EDGE_BEFORE}${escapeRegExp(v)}${WORD_EDGE_AFTER}`, "gu"), " "), text);
}

/** Every banned term in the visible text of `html`, outside the allowed user values, with the string it was found in. */
export function bannedTerms(html: string, options: PlainLanguageOptions = {}): Array<{ term: string; text: string }> {
  const allow = options.allow ?? [];
  return visibleText(html).flatMap((text) => bannedTermsInText(withoutAllowed(text, allow)).map((term) => ({ term, text })));
}

/**
 * Throws, listing every problem, when the visible text of `html` uses a banned term, or the page has more
 * than one help block, or its help block's text is not the fixed connection help for `connectorUrl`.
 */
export function expectPlainLanguage(html: string, options: PlainLanguageOptions = {}): void {
  const problems = bannedTerms(html, options).map((f) => `"${f.term}" in: ${f.text}`);
  const help = helpBlockTexts(html);
  if (help.length > 1) problems.push(`${help.length} help blocks; a page may have at most one`);
  if (help.length > 0) {
    if (options.connectorUrl === undefined) {
      problems.push("a help block, but no connector address to check its text against");
    } else {
      const expected = expectedHelpText(options.connectorUrl);
      for (const text of help) if (text !== expected) problems.push(`help block text: ${text}\n    expected: ${expected}`);
    }
  }
  if (problems.length > 0) throw new Error(`plain-language check failed:\n${problems.map((p) => `  ${p}`).join("\n")}`);
}
