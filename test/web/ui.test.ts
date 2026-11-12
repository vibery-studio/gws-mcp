import { html } from "hono/html";
import { describe, expect, it } from "vitest";
import {
  CONTRAST_PAIRS,
  FONT_STYLESHEET_URL,
  PAGE_CSP,
  STYLESHEET,
  STYLE_HASH,
  TOKENS,
  breadcrumbs,
  checkbox,
  chip,
  confirmLayout,
  contrastRatio,
  flashBanner,
  helpBlock,
  postButton,
  renderMessagePage,
  renderPage,
  statusChip,
} from "../../src/web/ui";
import { ACCESS_COPY } from "../../src/web/access-copy";
import { COPY } from "../../src/web/copy";
import { expectPlainLanguage } from "./plain-language";

const EVIL = '<script>alert("x")</script>&\'';
const EVIL_ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;";

async function sha256Base64(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest));
}

function directives(csp: string): Map<string, string[]> {
  return new Map(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([name = "", ...values]) => [name, values]));
}

const user = { email: "me@example.test", csrf: "c".repeat(43) };

describe("page security policy", () => {
  it("allows exactly the shared stylesheet by its hash, the font stylesheet and font files", async () => {
    expect(STYLE_HASH).toBe(`sha256-${await sha256Base64(STYLESHEET)}`);
    const d = directives(PAGE_CSP);
    expect(d.get("default-src")).toEqual(["'none'"]);
    expect(d.get("style-src")).toEqual([`'${STYLE_HASH}'`, "https://fonts.googleapis.com"]);
    expect(d.get("font-src")).toEqual(["https://fonts.gstatic.com"]);
    expect(d.get("base-uri")).toEqual(["'none'"]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
    // No script at all, no inline styles beyond the hashed sheet, and no form-action: browsers apply it to the
    // redirects after a form (the consent form's to the AI app, the connect forms' to Google and onward).
    expect([...d.keys()].sort()).toEqual(["base-uri", "default-src", "font-src", "frame-ancestors", "style-src"]);
    expect(PAGE_CSP).not.toContain("unsafe");
    expect(PAGE_CSP).not.toContain("form-action");
    expect(FONT_STYLESHEET_URL.startsWith("https://fonts.googleapis.com/css2?")).toBe(true);
  });

  it("renders the stylesheet byte for byte as hashed, once, with no script and no style attributes", async () => {
    const page = await renderPage({ title: "T", user, current: "home", body: html`<p>Body</p>` });
    expect(page.split(`<style>${STYLESHEET}</style>`)).toHaveLength(2);
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/\sstyle=/i);
    expect(page).not.toMatch(/\son[a-z]+=/i);
    expect(page).toContain(`<link rel="stylesheet" href="${FONT_STYLESHEET_URL.replace(/&/g, "&amp;")}">`);
  });
});

describe("design tokens", () => {
  it("defines every ARD token as a custom property, both fonts with fallbacks, and the motion rules", () => {
    for (const [name, value] of Object.entries(TOKENS)) expect(STYLESHEET).toContain(`--${name}:${value}`);
    expect(STYLESHEET).toContain('"Be Vietnam Pro",system-ui');
    expect(STYLESHEET).toContain('"JetBrains Mono",ui-monospace');
    expect(STYLESHEET).toContain("cubic-bezier(.2,.7,.2,1)");
    expect(STYLESHEET).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[^}]*transition:none!important/);
    expect(STYLESHEET).toMatch(/:focus-visible\{outline:2px solid var\(--accent\)/);
    expect(STYLESHEET).toContain("font:400 16px/1.6 var(--sans)");
    expect(STYLESHEET).toContain("--tap:44px");
    expect(STYLESHEET).toMatch(/@media \(max-width:480px\)\{[^@]*\.btn-primary[^}]*width:100%/);
  });

  it.each(CONTRAST_PAIRS)("%s on %s meets WCAG AA (%s)", (fg, bg, use) => {
    const ratio = contrastRatio(TOKENS[fg], TOKENS[bg]);
    expect(ratio).toBeGreaterThanOrEqual(use === "text" ? 4.5 : 3);
  });
});

describe("page shell", () => {
  it("shows the three areas with only the current one marked, the signed-in email and sign out", async () => {
    const page = await renderPage({ title: "Accounts", user, current: "accounts", body: html`<p>x</p>` });
    const nav = /<nav class="nav" aria-label="Main">([\s\S]*?)<\/nav>/.exec(page)?.[1] ?? "";
    expect([...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]])).toEqual([
      ["/", COPY.nav.home],
      ["/accounts", COPY.nav.accounts],
      ["/apps", COPY.nav.apps],
    ]);
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    expect(nav).toContain(`<a href="/accounts" aria-current="page">`);
    expect(page).toContain(`<span class="mono">${user.email}</span>`);
    expect(page).toMatch(/<form method="post" action="\/logout"[^>]*>\s*<input type="hidden" name="csrf" value="c{43}">/);
    expect(page).toContain('<html lang="en">');
    expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(page).toContain('<meta name="referrer" content="same-origin">');
    expect(page).toContain('<main id="main"');
    expectPlainLanguage(page);
  });

  it("adds the access list's item for an admin only, marked when it is the current area", async () => {
    const navOf = (page: string) => /<nav class="nav" aria-label="Main">([\s\S]*?)<\/nav>/.exec(page)?.[1] ?? "";
    const admin = navOf(await renderPage({ title: "Who", user: { ...user, isAdmin: true }, current: "access", body: html`<p>x</p>` }));
    expect(admin).toContain(`<a href="/access" aria-current="page">${ACCESS_COPY.nav}</a>`);
    for (const u of [user, { ...user, isAdmin: false }]) {
      expect(navOf(await renderPage({ title: "A", user: u, current: "accounts", body: html`<p>x</p>` }))).not.toContain("/access");
    }
  });

  it("has no navigation or sign-out without a signed-in user", async () => {
    const page = await renderPage({ title: "Hello", body: html`<p>x</p>`, referrer: "no-referrer" });
    expect(page).not.toContain('<nav class="nav"');
    expect(page).not.toContain("/logout");
    expect(page).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("escapes every value it is given", async () => {
    const page = await renderPage({
      title: EVIL,
      user: { email: EVIL, csrf: EVIL },
      current: "apps",
      crumbs: [{ href: "/apps", label: EVIL }, { label: EVIL }],
      flash: { tone: "success", text: EVIL, link: { href: "/apps", label: EVIL } },
      body: html`<p>${EVIL}</p>`,
    });
    expect(page).not.toContain("<script>alert");
    expect(page.split(EVIL_ESCAPED).length - 1).toBeGreaterThanOrEqual(7);
  });
});

describe("components", () => {
  it("announces a success or warning flash politely and an error at once", async () => {
    const ok = (await flashBanner({ tone: "success", text: "Saved." })).toString();
    const warn = (await flashBanner({ tone: "warning", text: "Careful." })).toString();
    const err = (await flashBanner({ tone: "error", text: "Failed." })).toString();
    expect(ok).toMatch(/^<div class="flash flash-success" role="status">/);
    expect(warn).toMatch(/^<div class="flash flash-warning" role="status">/);
    expect(err).toMatch(/^<div class="flash flash-error" role="alert">/);
    const linked = (await flashBanner({ tone: "success", text: "Work is connected.", link: { href: "/apps", label: "Manage AI apps" } })).toString();
    expect(linked).toContain('<a href="/apps">Manage AI apps</a>');
  });

  it("labels account status chips with the glossary words", async () => {
    expect((await statusChip("active")).toString()).toBe(`<span class="chip chip-ok">${COPY.status.active}</span>`);
    expect((await statusChip("reconnect")).toString()).toBe(`<span class="chip chip-warn">${COPY.status.reconnect}</span>`);
    expect((await statusChip("disconnected")).toString()).toBe(`<span class="chip chip-off">${COPY.status.disconnected}</span>`);
    expect((await chip("default", COPY.chips.default)).toString()).toBe(`<span class="chip chip-default">Default</span>`);
  });

  it("styles a real checkbox inside its label, checked only when asked", async () => {
    const off = (await checkbox({ name: "account", value: EVIL, label: html`Work`, detail: html`<span class="mono">w@x.test</span>` })).toString();
    expect(off).toMatch(/^<label class="check"><input type="checkbox" name="account" value="&lt;script/);
    expect(off).not.toContain(" checked");
    const on = (await checkbox({ name: "account", value: "a1", label: html`Work`, checked: true })).toString();
    expect(on).toContain('<input type="checkbox" name="account" value="a1" checked>');
  });

  it("posts a one-button form with the CSRF token and hidden fields", async () => {
    const form = (await postButton({ csrf: "t", action: "/connections/set-default", label: "Make default", fields: { account: EVIL } })).toString();
    expect(form).toBe(
      `<form method="post" action="/connections/set-default" class="inline"><input type="hidden" name="csrf" value="t"><input type="hidden" name="account" value="${EVIL_ESCAPED}"><button type="submit" class="btn btn-ghost">Make default</button></form>`,
    );
  });

  it("builds breadcrumbs with the current page marked", async () => {
    const crumbs = (await breadcrumbs([{ href: "/accounts", label: "Google accounts" }, { label: "Work" }])).toString();
    expect(crumbs).toBe(
      '<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/accounts">Google accounts</a></li><li><span aria-current="page">Work</span></li></ol></nav>',
    );
  });

  it("lays out a confirmation with what stops, what stays, the action and a way back", async () => {
    const page = (
      await confirmLayout({
        heading: "Disconnect Work?",
        stops: ["This will stop all your AI apps from using Work."],
        stays: [COPY.trust.googleDataNotDeleted],
        action: html`<button type="submit" class="btn btn-destructive">Disconnect Work</button>`,
        cancelHref: "/accounts/a1",
      })
    ).toString();
    expect(page).toContain('<h1 class="title">Disconnect Work?</h1>');
    expect(page).toContain("<li>This will stop all your AI apps from using Work.</li>");
    expect(page).toContain(`<li>${COPY.trust.googleDataNotDeleted.replace("'", "&#39;")}</li>`);
    expect(page).toContain(`<a class="btn btn-ghost" href="/accounts/a1">${COPY.actions.cancel}</a>`);
    expectPlainLanguage(page);
  });

  it("renders only the fixed connection help, escaped and marked for the plain-language check", async () => {
    const url = "https://x.example/mcp?a=1&b=<2>";
    const help = (await helpBlock(url)).toString();
    expect(help).toMatch(/^<aside class="help" data-help><h2>/);
    expect(help).toContain("https://x.example/mcp?a=1&amp;b=&lt;2&gt;");
    expect(help).not.toContain("<2>");
    expectPlainLanguage(help, { connectorUrl: url });
  });
});

describe("message page", () => {
  it("renders in the shared shell, escaped and in plain words", async () => {
    const page = await renderMessagePage(EVIL, EVIL);
    expect(page).toContain(`<style>${STYLESHEET}</style>`);
    expect(page).not.toContain("<script>alert");
    expect(page).toContain(`<h1 class="title">${EVIL_ESCAPED}</h1>`);
    expectPlainLanguage(await renderMessagePage("Signed out", "You are signed out of gws-mcp."));
  });
});
