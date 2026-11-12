import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { AccountStatus } from "../store/db";
import { ACCESS_COPY, ACCESS_PATH } from "./access-copy";
import { COPY, connectAppHelp } from "./copy";

/**
 * The shared look of every HTML page: the ARD design tokens, one static stylesheet, the page shell with its
 * persistent navigation, the components the pages compose, and the one Content-Security-Policy they are
 * served with. No script anywhere: every control is a native link or form.
 *
 * Every value passed in is escaped by `hono/html`; nothing here wraps caller data in `raw`.
 */

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** ARD design system v3 tokens. Each becomes a CSS custom property of the same name. */
export const TOKENS = {
  ink: "#0a0f14",
  dark: "#051c2c",
  accent: "#2251ff",
  "accent-hover": "#1a40d9",
  paper: "#f7f8fa",
  wash: "#eef2ff",
  muted: "#5b6675",
  line: "#e3e7ee",
  white: "#ffffff",
  green: "#0b6b4f",
  "green-soft": "#edf8f3",
  amber: "#8a5a00",
  "amber-soft": "#fff6d6",
  red: "#be123c",
  "red-soft": "#fff1f2",
} as const;

export type TokenName = keyof typeof TOKENS;

/**
 * The colour pairs the stylesheet puts text or controls on, with what they carry: `text` needs 4.5:1 and
 * `ui` (focus ring, control borders) 3:1 under WCAG 2.2 AA.
 */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [TokenName, TokenName, "text" | "ui"]> = [
  ["ink", "white", "text"],
  ["ink", "paper", "text"],
  ["ink", "wash", "text"],
  ["muted", "white", "text"],
  ["muted", "paper", "text"],
  ["muted", "wash", "text"],
  ["accent", "white", "text"],
  ["accent", "paper", "text"],
  ["accent", "wash", "text"],
  ["accent-hover", "white", "text"],
  ["white", "ink", "text"],
  ["white", "dark", "text"],
  ["white", "red", "text"],
  ["green", "green-soft", "text"],
  ["amber", "amber-soft", "text"],
  ["red", "red-soft", "text"],
  ["red", "white", "text"],
  ["red", "paper", "text"],
  ["accent", "white", "ui"],
  ["accent", "paper", "ui"],
  ["muted", "white", "ui"],
];

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const CUSTOM_PROPERTIES = Object.entries(TOKENS)
  .map(([name, value]) => `--${name}:${value}`)
  .join(";");

/**
 * The one stylesheet. It is inlined in every page and allowed by its hash (`STYLE_HASH`), so it must stay a
 * constant: any edit needs the hash updated, which the ui test checks.
 */
export const STYLESHEET = [
  `:root{${CUSTOM_PROPERTIES};--sans:"Be Vietnam Pro",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--radius:6px;--pill:999px;--ease:cubic-bezier(.2,.7,.2,1);--gutter:clamp(20px,5.5vw,80px);--container:960px;--tap:44px}`,
  "*,*::before,*::after{box-sizing:border-box}",
  "html{-webkit-text-size-adjust:100%;text-size-adjust:100%}",
  "body{margin:0;background:var(--white);color:var(--ink);font:400 16px/1.6 var(--sans);overflow-wrap:break-word}",
  "a{color:var(--accent);text-underline-offset:.2em}",
  "a:hover{color:var(--accent-hover)}",
  ":focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
  ".wrap{max-width:calc(var(--container) + 2 * var(--gutter));margin:0 auto;padding:0 var(--gutter)}",
  ".skip{position:absolute;left:-10000px;top:8px;z-index:1;padding:10px 16px;background:var(--ink);color:var(--white);border-radius:var(--pill)}",
  ".skip:focus{left:var(--gutter)}",
  ".top{border-bottom:1px solid var(--line);background:var(--white)}",
  ".top-in{display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px;min-height:68px;padding-top:10px;padding-bottom:10px}",
  ".mark{display:inline-flex;align-items:center;min-height:var(--tap);font-weight:600;letter-spacing:-.01em;color:var(--ink);text-decoration:none}",
  ".nav{display:flex;flex:1 1 auto;gap:4px}",
  ".nav a{display:inline-flex;align-items:center;justify-content:center;min-height:var(--tap);padding:0 16px;border-radius:var(--pill);color:var(--muted);font-weight:500;white-space:nowrap;text-decoration:none;transition:background-color .2s var(--ease),color .2s var(--ease)}",
  ".nav a:hover{color:var(--ink);background:var(--paper)}",
  '.nav a[aria-current="page"]{color:var(--ink);background:var(--wash)}',
  ".who{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;min-width:0;margin-left:auto;color:var(--muted);font-size:14px}",
  ".main{padding-top:clamp(28px,5vw,56px);padding-bottom:96px}",
  "h1,h2,h3{color:var(--ink)}",
  ".title{font-weight:300;font-size:clamp(32px,4.4vw,40px);line-height:1.15;letter-spacing:-.025em;margin:0 0 12px}",
  "h2{font-weight:500;font-size:22px;line-height:1.3;margin:40px 0 12px}",
  "h3{font-weight:600;font-size:18px;line-height:1.35;margin:0}",
  "p{margin:0 0 12px}",
  ".eyebrow{font-size:13px;font-weight:500;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:0 0 12px}",
  ".lede{color:var(--muted);font-size:17px;max-width:42em;margin-bottom:28px}",
  ".muted{color:var(--muted)}",
  ".small{font-size:14px}",
  ".mono{font-family:var(--mono);font-size:.92em;overflow-wrap:anywhere}",
  ".stack>*+*{margin-top:16px}",
  ".grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr))}",
  ".list{list-style:none;margin:0;padding:0;display:grid;gap:12px}",
  ".card{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:clamp(20px,3vw,28px)}",
  ".card-wash{background:var(--wash);border-color:var(--wash)}",
  ".card-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px}",
  ".card-name{font-size:22px;font-weight:500;line-height:1.3;margin:0}",
  ".card-name a{color:var(--ink);text-decoration:none}",
  ".card-name a:hover{color:var(--accent);text-decoration:underline}",
  ".card>:last-child{margin-bottom:0}",
  ".card-head .chips{margin:0}",
  ".chips{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:10px 0;padding:0}",
  ".chip{display:inline-flex;align-items:center;padding:2px 12px;border:1px solid var(--line);border-radius:var(--pill);background:var(--white);color:var(--ink);font-size:13px;font-weight:500;line-height:1.6;white-space:nowrap}",
  ".chip-ok{background:var(--green-soft);border-color:var(--green-soft);color:var(--green)}",
  ".chip-warn{background:var(--amber-soft);border-color:var(--amber-soft);color:var(--amber)}",
  ".chip-off{background:var(--red-soft);border-color:var(--red-soft);color:var(--red)}",
  ".chip-default{background:var(--wash);border-color:var(--wash);color:var(--accent)}",
  ".btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:var(--tap);padding:0 22px;border:1px solid var(--ink);border-radius:var(--pill);background:var(--white);color:var(--ink);font:500 15px/1.2 var(--sans);text-align:center;text-decoration:none;cursor:pointer;transition:background-color .2s var(--ease),color .2s var(--ease),border-color .2s var(--ease)}",
  ".btn:hover{color:var(--ink)}",
  ".btn-primary{background:var(--ink);border-color:var(--ink);color:var(--white)}",
  ".btn-primary:hover{background:var(--dark);border-color:var(--dark);color:var(--white)}",
  ".btn-ghost{background:transparent;border-color:var(--line)}",
  ".btn-ghost:hover{border-color:var(--ink)}",
  ".btn-danger{background:transparent;border-color:transparent;color:var(--red);padding:0 8px;text-decoration:underline;text-underline-offset:.2em}",
  ".btn-danger:hover{background:var(--red-soft);color:var(--red)}",
  ".btn-destructive{background:var(--red);border-color:var(--red);color:var(--white)}",
  ".btn-destructive:hover{background:var(--ink);border-color:var(--ink);color:var(--white)}",
  ".actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:24px}",
  "form.inline{display:inline}",
  ".field{display:grid;gap:6px;margin:0 0 16px}",
  ".field label{font-weight:500}",
  ".hint{color:var(--muted);font-size:14px;margin:0}",
  ".field-error{color:var(--red);font-size:14px;font-weight:500;margin:0}",
  'input[type="text"]{width:100%;max-width:28rem;min-height:var(--tap);padding:8px 14px;border:1px solid var(--muted);border-radius:var(--radius);background:var(--white);color:var(--ink);font:inherit}',
  'input[aria-invalid="true"]{border-color:var(--red)}',
  "fieldset{min-width:0;margin:0;padding:0;border:0}",
  "legend{padding:0;margin:0 0 12px;font-weight:600;font-size:18px}",
  ".check{display:flex;align-items:flex-start;gap:14px;min-height:var(--tap);padding:14px 16px;border:1px solid var(--line);border-radius:var(--radius);background:var(--white);cursor:pointer}",
  ".check+.check{margin-top:8px}",
  ".check input{flex:none;width:22px;height:22px;margin:1px 0 0;accent-color:var(--accent);cursor:pointer}",
  ".check:has(input:checked){border-color:var(--accent);background:var(--wash)}",
  ".check-body{display:grid;gap:2px;min-width:0}",
  ".flash{padding:14px 18px;margin:0 0 24px;border:1px solid transparent;border-radius:var(--radius)}",
  ".flash p{margin:0}",
  ".flash a{color:inherit;font-weight:600}",
  ".flash-success{background:var(--green-soft);color:var(--green)}",
  ".flash-warning{background:var(--amber-soft);color:var(--amber)}",
  ".flash-error{background:var(--red-soft);color:var(--red)}",
  ".crumbs ol{display:flex;flex-wrap:wrap;align-items:center;gap:0 8px;list-style:none;margin:0 0 8px;padding:0;color:var(--muted);font-size:14px}",
  '.crumbs li+li::before{content:"/";margin-right:8px}',
  ".crumbs a{display:inline-flex;align-items:center;min-height:var(--tap)}",
  '.crumbs [aria-current="page"]{color:var(--ink)}',
  ".confirm{max-width:38rem}",
  ".confirm h2{font-size:16px;font-weight:600;margin:20px 0 6px}",
  ".confirm .card>h2:first-child{margin-top:0}",
  ".confirm ul{margin:0;padding-left:1.25em}",
  ".help{margin:32px 0 0;padding:18px 22px;border-left:3px solid var(--accent);border-radius:0 var(--radius) var(--radius) 0;background:var(--paper)}",
  ".help h2{margin-top:0;font-size:18px}",
  "details>summary{display:flex;align-items:center;min-height:var(--tap);cursor:pointer}",
  ".sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}",
  "@media (max-width:480px){.top-in{gap:4px 12px}.who-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.nav{order:3;flex-basis:100%;gap:2px}.nav a{flex:1 1 auto;padding:0 10px;font-size:15px}.actions{flex-direction:column;align-items:stretch}.actions .btn,.btn-primary,.btn-destructive{width:100%}.card-head{flex-direction:column}}",
  "@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}",
].join("\n");

/** `sha256-<base64>` of STYLESHEET, the only inline style the policy allows. The ui test recomputes it. */
export const STYLE_HASH = "sha256-LT4vh/rqZt7Ri7z/+QGQcAop3fA4LNi9mngfszMvU3U=";

/** Be Vietnam Pro 300–700 and JetBrains Mono 400–500 from Google Fonts; the stylesheet names system fallbacks. */
export const FONT_STYLESHEET_URL =
  "https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";

/**
 * Policy for every HTML page this server renders. Nothing runs (no script source at all), nothing frames
 * it, and the only styles are the hashed shared sheet plus the Google Fonts sheet and its font files; `style`
 * attributes are therefore refused too. There is deliberately no `form-action`: browsers apply it to every
 * redirect after a form, and the consent form goes on to the AI app's own address, the connect forms to
 * Google and from there possibly to a Workspace sign-in provider (or, in fake mode, to the fake host).
 */
export const PAGE_CSP = `default-src 'none'; style-src '${STYLE_HASH}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; frame-ancestors 'none'`;

/**
 * Referrer policy of the signed-in pages. Not `no-referrer`: under it browsers send `Origin: null` on a
 * same-origin form POST, and every guarded POST requires this site's Origin. `same-origin` sends nothing to
 * other sites (the font requests carry no referrer).
 */
export const PAGE_REFERRER_POLICY = "same-origin";

export type NavKey = "home" | "accounts" | "apps" | "access";
export type FlashTone = "success" | "warning" | "error";

export interface ShellUser {
  /** The signed-in user's sign-in email, always shown (mono, so the plain-language check skips it). */
  email: string;
  /** The session's CSRF token, posted by the sign-out form. */
  csrf: string;
  /** Shows the access list's nav item. Display only: the access routes check the role themselves. */
  isAdmin?: boolean;
}

/** A banner's text, already worded by the page. */
export interface FlashMessage {
  tone: FlashTone;
  text: string;
  link?: { href: string; label: string };
}

export interface Crumb {
  label: string;
  /** Absent on the current page. */
  href?: string;
}

export interface PageInput {
  /** The page's own title; the browser title adds the product name. */
  title: string;
  body: Html;
  /** Navigation and sign-out appear only for a signed-in user. */
  user?: ShellUser;
  /** The area marked `aria-current` in the navigation. */
  current?: NavKey;
  crumbs?: readonly Crumb[];
  flash?: FlashMessage | null;
  referrer?: "same-origin" | "no-referrer";
}

const NAV: ReadonlyArray<readonly [NavKey, string, string]> = [
  ["home", "/", COPY.nav.home],
  ["accounts", "/accounts", COPY.nav.accounts],
  ["apps", "/apps", COPY.nav.apps],
];

function header(user: ShellUser | undefined, current: NavKey | undefined): Html {
  if (!user) {
    return html`<header class="top"><div class="wrap top-in"><a class="mark" href="/">${COPY.product}</a></div></header>`;
  }
  const nav = user.isAdmin === true ? [...NAV, ["access", ACCESS_PATH, ACCESS_COPY.nav] as const] : NAV;
  const items = nav.map(([key, href, label]) =>
    key === current ? html`<a href="${href}" aria-current="page">${label}</a>` : html`<a href="${href}">${label}</a>`,
  );
  return html`<header class="top"><div class="wrap top-in">
<a class="mark" href="/">${COPY.product}</a>
<nav class="nav" aria-label="${COPY.shell.navLabel}">${items}</nav>
<div class="who"><span><span class="who-label">${COPY.shell.signedInAs} </span><span class="mono">${user.email}</span></span>
<form method="post" action="/logout" class="inline">
<input type="hidden" name="csrf" value="${user.csrf}">
<button type="submit" class="btn btn-ghost">${COPY.shell.signOut}</button>
</form></div>
</div></header>`;
}

/** A whole HTML document in the shared shell. */
export async function renderPage(p: PageInput): Promise<string> {
  const page = await html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="${p.referrer ?? PAGE_REFERRER_POLICY}">
<title>${p.title} · ${COPY.product}</title>
<link rel="stylesheet" href="${FONT_STYLESHEET_URL}">
<style>${raw(STYLESHEET)}</style>
</head>
<body>
<a class="skip" href="#main">${COPY.shell.skipToContent}</a>
${header(p.user, p.current)}
<main id="main" class="wrap main">
${p.crumbs && p.crumbs.length > 0 ? breadcrumbs(p.crumbs) : ""}
${p.flash ? flashBanner(p.flash) : ""}
${p.body}
</main>
</body>
</html>`;
  return page.toString();
}

/** A plain message page (errors, sign-out): no navigation, since it may be shown without a session. */
export function renderMessagePage(title: string, message: string): Promise<string> {
  return renderPage({ title, referrer: "no-referrer", body: html`<h1 class="title">${title}</h1>\n<p class="lede">${message}</p>` });
}

/** The success, warning or error banner. Errors interrupt the screen reader; the others wait their turn. */
export function flashBanner(m: FlashMessage): Html {
  const role = m.tone === "error" ? "alert" : "status";
  return html`<div class="flash flash-${m.tone}" role="${role}"><p>${m.text}${m.link ? html` <a href="${m.link.href}">${m.link.label}</a>` : ""}</p></div>`;
}

export type ChipTone = "ok" | "warn" | "off" | "default" | "plain";

export function chip(tone: ChipTone, text: string): Html {
  return tone === "plain" ? html`<span class="chip">${text}</span>` : html`<span class="chip chip-${tone}">${text}</span>`;
}

const STATUS_TONE: Readonly<Record<AccountStatus, ChipTone>> = { active: "ok", reconnect: "warn", disconnected: "off" };

/** An account's connection status in glossary words. */
export function statusChip(status: AccountStatus): Html {
  return chip(STATUS_TONE[status], COPY.status[status]);
}

export function breadcrumbs(items: readonly Crumb[]): Html {
  const li = items.map((c) =>
    c.href === undefined ? html`<li><span aria-current="page">${c.label}</span></li>` : html`<li><a href="${c.href}">${c.label}</a></li>`,
  );
  return html`<nav class="crumbs" aria-label="${COPY.shell.breadcrumbLabel}"><ol>${li}</ol></nav>`;
}

export type ButtonVariant = "primary" | "ghost" | "danger" | "destructive";

/** A link styled as a pill button. */
export function linkButton(href: string, label: string, variant: ButtonVariant = "ghost"): Html {
  return html`<a class="btn btn-${variant}" href="${href}">${label}</a>`;
}

/** A one-button form posting `fields` and the session's CSRF token. */
export function postButton(p: { csrf: string; action: string; label: string; fields?: Readonly<Record<string, string>>; variant?: ButtonVariant }): Html {
  const hidden = Object.entries(p.fields ?? {}).map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`);
  return html`<form method="post" action="${p.action}" class="inline"><input type="hidden" name="csrf" value="${p.csrf}">${hidden}<button type="submit" class="btn btn-${p.variant ?? "ghost"}">${p.label}</button></form>`;
}

/** A real checkbox styled as a tappable row; the whole label toggles it. */
export function checkbox(p: { name: string; value: string; label: Html; detail?: Html; checked?: boolean }): Html {
  return html`<label class="check"><input type="checkbox" name="${p.name}" value="${p.value}"${p.checked ? raw(" checked") : ""}><span class="check-body"><span>${p.label}</span>${p.detail ?? ""}</span></label>`;
}

/**
 * A confirmation page body for a sensitive action: what stops, what stays, the action (a form the page
 * builds) and a way back that changes nothing.
 */
export function confirmLayout(p: {
  heading: string;
  lede?: string;
  stops: readonly string[];
  stays: readonly string[];
  action: Html;
  cancelHref: string;
}): Html {
  const list = (items: readonly string[]) => html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`;
  return html`<div class="confirm">
<h1 class="title">${p.heading}</h1>
${p.lede ? html`<p class="lede">${p.lede}</p>` : ""}
<div class="card">
${p.stops.length > 0 ? html`<h2>What stops</h2>${list(p.stops)}` : ""}
${p.stays.length > 0 ? html`<h2>What stays</h2>${list(p.stays)}` : ""}
</div>
<div class="actions">${p.action}<a class="btn btn-ghost" href="${p.cancelHref}">${COPY.actions.cancel}</a></div>
</div>`;
}

/**
 * The static help on connecting an AI app: the fixed connection help (`connectAppHelp`) for the server's
 * connector address, and nothing else. It is the only place a page may show a technical word (the address),
 * so it is marked `data-help`; the plain-language check pins its text, so it takes no other content.
 */
export function helpBlock(connectorUrl: string): Html {
  const help = connectAppHelp(connectorUrl);
  return html`<aside class="help" data-help><h2>${help.title}</h2><ol>${help.steps.map((step) => html`<li>${step}</li>`)}</ol></aside>`;
}
