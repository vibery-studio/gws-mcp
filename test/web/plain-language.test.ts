import { describe, expect, it } from "vitest";
import { helpBlock } from "../../src/web/ui";
import { BANNED_TERMS, bannedTerms, bannedTermsInText, expectPlainLanguage, expectedHelpText, helpBlockTexts, visibleText } from "./plain-language";

describe("plain-language check", () => {
  it.each(BANNED_TERMS)("finds %s as a whole word in any case and with common endings", (term) => {
    expect(bannedTermsInText(`Use the ${term.toUpperCase()} here`)).toEqual([term.toUpperCase()]);
    expect(bannedTermsInText(`two ${term}s`)).toHaveLength(1);
    expect(bannedTermsInText(`${term}.`)).toHaveLength(1);
  });

  it("does not match a term inside a longer word, or the hyphenated product name", () => {
    expect(bannedTermsInText("gws-mcp keeps your Google accounts")).toEqual([]);
    expect(bannedTermsInText("Telescope, emigrant, clientele, tokenizer, aliasing-free")).toEqual([]);
    expect(bannedTermsInText("Revoked access, granted, MCP, /mcp, oauth2? no: OAuth")).toEqual(["Revoked", "granted", "MCP", "mcp", "OAuth"]);
  });

  it("reads text nodes, the title, button values and text-valued attributes, decoding entities", () => {
    const html = `<!doctype html><html><head><title>Client list</title><style>.client{color:red}</style></head>
<body><h1 title="the scope">Hi &amp; welcome</h1><img alt="a token">
<input type="submit" value="Revoke it"><input type="hidden" name="client" value="client">
<a aria-label="Grant access" aria-describedby="client-help">x</a><!-- client --></body></html>`;
    expect(visibleText(html)).toEqual(["Client list", "the scope", "Hi & welcome", "a token", "Revoke it", "Grant access", "x"]);
    expect(bannedTerms(html).map((f) => f.term)).toEqual(["Client", "scope", "token", "Revoke", "Grant"]);
  });

  it("skips mono text only when it is an email address or a generated id", () => {
    const html = `<main><p>Plain words.</p>
<p>Email: <span class="mono">client@alias.example</span></p>
<ul><li class="chip mono">a_1f0c2b7e-6a1d-4d1e-9c55-1b2c3d4e5f60</li><li>After the list</li></ul></main>`;
    expect(visibleText(html)).toEqual(["Plain words.", "Email:", "After the list"]);
    expect(() => expectPlainLanguage(html)).not.toThrow();
    // Any other mono text is read like the rest of the page.
    expect(visibleText(`<p><span class="mono">MCP <b>Client</b></span></p><p class="mono">x@y</p><p class="mono">gws_session</p>`)).toEqual(["MCP Client", "x@y", "gws_session"]);
    expect(bannedTerms(`<p><span class="mono">Revoke grants</span></p>`).map((f) => f.term)).toEqual(["Revoke", "grants"]);
    expect(() => expectPlainLanguage(`<p><span class="mono">MCP token</span></p>`)).toThrow(/"MCP" in: MCP token/);
  });

  it("allows only the user values it is given, wherever they appear", () => {
    const html = `<h1>Token wallet</h1><p>Allowed for: <bdi>MCP Client</bdi>, Notes</p><input type="submit" value="Disconnect Token wallet">`;
    expect(bannedTerms(html).map((f) => f.term)).toEqual(["Token", "MCP", "Client", "Token"]);
    expect(bannedTerms(html, { allow: ["MCP Client"] }).map((f) => f.term)).toEqual(["Token", "Token"]);
    expect(() => expectPlainLanguage(html, { allow: ["token wallet", "MCP Client"] })).toThrow(/"Token" in: Token wallet/);
    expect(() => expectPlainLanguage(html, { allow: ["Token wallet", "MCP Client", ""] })).not.toThrow();
    // Allowing a value never hides a banned word next to it.
    expect(bannedTerms("<p>Revoke Token wallet</p>", { allow: ["Token wallet"] }).map((f) => f.term)).toEqual(["Revoke"]);
  });

  it("removes an allowed value only as a whole word, never from inside a longer word", () => {
    const html = "<p>Remove the client token for Ok</p>";
    expect(bannedTerms(html, { allow: ["ok", "lie"] }).map((f) => f.term)).toEqual(["client", "token"]);
    expect(bannedTerms(html, { allow: ["en", "nt", "t"] }).map((f) => f.term)).toEqual(["client", "token"]);
    // A whole allowed value is still removed, whatever characters it starts or ends with.
    expect(bannedTerms("<p>Ok, (token) and client.</p>", { allow: ["(token)", "client."] })).toEqual([]);
  });

  it("accepts one help block holding exactly the connection help for the connector address", async () => {
    const url = "https://x.example/mcp";
    const page = `<main><p>Plain words.</p>${(await helpBlock(url)).toString()}</main>`;
    expect(helpBlockTexts(page)).toEqual([expectedHelpText(url)]);
    expect(visibleText(page)).toEqual(["Plain words."]);
    expect(() => expectPlainLanguage(page, { connectorUrl: url })).not.toThrow();
  });

  it("fails a help block with other text, a second help block, or no connector address to check it against", async () => {
    const url = "https://x.example/mcp";
    const help = (await helpBlock(url)).toString();
    const smuggled = `<aside class="help" data-help><p>Add ${url} as an MCP connector. Revoke the client token.</p></aside>`;
    expect(() => expectPlainLanguage(smuggled, { connectorUrl: url })).toThrow(/help block text: Add https:\/\/x\.example\/mcp as an MCP connector/);
    expect(() => expectPlainLanguage(help.replace("</aside>", "<p>One more line</p></aside>"), { connectorUrl: url })).toThrow(/help block text/);
    expect(() => expectPlainLanguage(help, { connectorUrl: "https://other.example/mcp" })).toThrow(/help block text/);
    expect(() => expectPlainLanguage(`${help}${help}`, { connectorUrl: url })).toThrow(/2 help blocks/);
    expect(() => expectPlainLanguage(`<div data-help>${help}</div>`, { connectorUrl: url })).toThrow(/2 help blocks/);
    expect(() => expectPlainLanguage(help)).toThrow(/no connector address/);
    // Attributes inside the help block count toward its text.
    expect(() => expectPlainLanguage(help.replace("<h2>", '<h2 title="client token">'), { connectorUrl: url })).toThrow(/help block text/);
  });

  it("fails with every offending string listed", () => {
    expect(() => expectPlainLanguage("<p>Revoke this client</p><button>OK</button>")).toThrow(/"Revoke" in: Revoke this client[\s\S]*"client" in: Revoke this client/);
  });
});
