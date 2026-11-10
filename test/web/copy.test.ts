import { describe, expect, it } from "vitest";
import { GOOGLE_SERVICES, SERVICE_SCOPES } from "../../src/config";
import { GWS_ERROR_CODES } from "../../src/errors";
import {
  COPY,
  GLOSSARY,
  PLAIN_ERROR_CODES,
  SERVICE_COPY_KEYS,
  SERVICE_NAMES,
  connectAppHelp,
  plainError,
  serviceDescription,
  serviceDescriptionBasis,
} from "../../src/web/copy";
import { bannedTermsInText } from "./plain-language";

/** Every string reachable in a value, calling copy templates with a sample name. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return strings((value as (name: string) => unknown)("Work"));
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("copy", () => {
  it("uses no technical term in any glossary term, explanation or shared string", () => {
    const all = [...strings(GLOSSARY), ...strings(COPY), ...Object.values(SERVICE_NAMES)];
    expect(all.length).toBeGreaterThan(50);
    expect(all.flatMap((s) => bannedTermsInText(s).map((t) => `${t} in: ${s}`))).toEqual([]);
  });

  it("holds the canonical glossary wording", () => {
    expect(GLOSSARY.signInWithGoogle.term).toBe("Continue with Google");
    expect(GLOSSARY.googleServices.term).toBe("Google services");
    expect(GLOSSARY.aiApp.term).toBe("AI app");
    expect(GLOSSARY.allowAccess.term).toBe("Allow access");
    expect(GLOSSARY.accountName.term).toBe("Account name");
    expect(COPY.status).toEqual({ active: "Connected", reconnect: "Needs reconnecting", disconnected: "Disconnected" });
    expect(COPY.actions.reconnect).toBe("Reconnect");
    expect(COPY.actions.removeAiApp).toBe("Remove AI app");
    expect(COPY.actions.disconnectAccount).toBe("Disconnect account");
    expect(COPY.trust.writeGuard).toBe(
      "Your AI app previews changes first and applies them only in a second, explicit step. Actions that can delete or remove information are flagged.",
    );
    expect(COPY.trust.newAccountNotShared("Work")).toBe("Your existing AI apps can't use Work yet.");
  });

  it("names the connector address only in the connection help", () => {
    const help = connectAppHelp("https://gws-mcp.example/mcp");
    expect(help.steps.join(" ")).toContain("https://gws-mcp.example/mcp");
    expect(strings(COPY).join(" ")).not.toContain("/mcp");
  });
});

describe("Google service descriptions", () => {
  it.each(SERVICE_COPY_KEYS)("%s %s is written for exactly the scopes the connect flow requests", (preset, service) => {
    expect([...serviceDescriptionBasis(preset, service)].sort()).toEqual([...SERVICE_SCOPES[preset][service]].sort());
  });

  it.each(SERVICE_COPY_KEYS)("%s %s is one plain line that never claims read-only use", (preset, service) => {
    const text = serviceDescription(preset, service);
    expect(text).toMatch(/^[A-Z][^\n]{10,100}\.$/);
    expect(text).not.toMatch(/read-only|read only|view only|view-only|only read|only view|can't change|cannot change/i);
    expect(bannedTermsInText(text)).toEqual([]);
  });

  it("names every service", () => {
    expect(Object.keys(SERVICE_NAMES).sort()).toEqual([...GOOGLE_SERVICES].sort());
  });
});

describe("plainError", () => {
  it.each(PLAIN_ERROR_CODES)("turns %s into a plain sentence without the code or a technical term", (code) => {
    const text = plainError(code, "Work");
    expect(text).toMatch(/^[A-Z].*\.$/);
    expect(text).not.toContain(code);
    expect(text).not.toMatch(/GWS_|_/);
    expect(bannedTermsInText(text)).toEqual([]);
  });

  it("maps Google's errors to the same actions as the matching server codes", () => {
    expect(plainError("invalid_grant", "Work")).toBe(plainError("GWS_RECONNECT_REQUIRED", "Work"));
    expect(plainError("invalid_grant", "Work")).toContain("reconnect Work");
    expect(plainError("insufficient_scope", "Work")).toBe(plainError("GWS_SCOPE_MISSING", "Work"));
    expect(plainError("GWS_SCOPE_MISSING")).toMatch(/^This account /);
  });

  it("gives the generic line for an unknown code and for internal failures", () => {
    expect(plainError("<b>nope</b>")).toBe(plainError("GWS_INTERNAL"));
    expect(GWS_ERROR_CODES.length).toBeGreaterThan(10);
  });
});
