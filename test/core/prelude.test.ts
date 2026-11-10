import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { EXECUTE_CPU_MS, runSandbox, type SandboxCall, type SandboxRun } from "../../src/core/execute";
import { workersSandbox } from "../../src/runtime/workers/sandbox";

interface Recorded {
  name: unknown;
  input: unknown;
}

/** A stub dispatcher: records every call and answers from `reply`. */
function stub(reply: (name: unknown, input: unknown) => unknown = () => ({ ok: true, value: null })) {
  const calls: Recorded[] = [];
  const call: SandboxCall = async (name, input) => {
    calls.push({ name, input });
    return reply(name, input);
  };
  return { calls, call };
}

function run(code: string, call: SandboxCall): Promise<SandboxRun> {
  return runSandbox({ sandbox: workersSandbox(env.LOADER), timeoutMs: 5000, cpuMs: EXECUTE_CPU_MS, code, call });
}

function returned(r: SandboxRun): unknown {
  if (r.status !== "returned") throw new Error(`expected a returned value, got ${JSON.stringify(r)}`);
  return r.json === undefined ? undefined : JSON.parse(r.json);
}

describe("sdk prelude", () => {
  it("dispatches a nested sdk path as one dotted name with the first argument as input", async () => {
    const s = stub(() => ({ ok: true, value: { messages: [{ id: "m1" }] } }));
    const r = await run("async () => await sdk.gmail.users.messages.list({ userId: 'me' })", s.call);
    expect(returned(r)).toEqual({ messages: [{ id: "m1" }] });
    expect(s.calls).toEqual([{ name: "gmail.users.messages.list", input: { userId: "me" } }]);
  });

  it("sends an empty object when the call has no argument", async () => {
    const s = stub();
    await run("async () => sdk.accounts.list()", s.call);
    expect(s.calls).toEqual([{ name: "accounts.list", input: {} }]);
  });

  it("throws a GwsError carrying code, details and fn for an error envelope", async () => {
    const s = stub(() => ({
      __gwsError: { code: "GWS_UNKNOWN_METHOD", message: "no SDK function has this name", fn: "<unknown>", details: { hint: "search" } },
    }));
    const r = await run(
      `async () => {
        try { await sdk.nope.nope({}); return "no throw"; }
        catch (e) { return { gws: e instanceof GwsError, isError: e instanceof Error, name: e.name, code: e.code, message: e.message, details: e.details, fn: e.fn }; }
      }`,
      s.call,
    );
    expect(returned(r)).toEqual({
      gws: true,
      isError: true,
      name: "GwsError",
      code: "GWS_UNKNOWN_METHOD",
      message: "GWS_UNKNOWN_METHOD: no SDK function has this name",
      details: { hint: "search" },
      fn: "<unknown>",
    });
  });

  it("an uncaught error envelope ends the snippet with a message that starts with the code", async () => {
    const s = stub(() => ({ __gwsError: { code: "GWS_SCOPE_MISSING", message: "connect drive" } }));
    const r = await run("async () => { await sdk.drive.files.list({}); return 1; }", s.call);
    expect(r).toMatchObject({ status: "threw", message: "GWS_SCOPE_MISSING: connect drive" });
  });

  it("gives the snippet only a structured GWS_INTERNAL error when the host call throws, never its message", async () => {
    const s = stub(() => {
      throw new Error("raw host failure with ya29.hostsecret and D1 details");
    });
    const r = await run(
      `async () => {
        try { await sdk.drive.files.list({}); return "no throw"; }
        catch (e) { return { gws: e instanceof GwsError, code: e.code, message: e.message }; }
      }`,
      s.call,
    );
    expect(returned(r)).toEqual({ gws: true, code: "GWS_INTERNAL", message: "GWS_INTERNAL: internal error" });
  });

  it("treats a malformed host reply as GWS_INTERNAL instead of returning it", async () => {
    const s = stub(() => ({ result: "not an envelope" }));
    const r = await run("async () => { try { return await sdk.a.b({}); } catch (e) { return e.code; } }", s.call);
    expect(returned(r)).toBe("GWS_INTERNAL");
  });

  it("returns a pending proxy whose fields stringify to pending tokens and which is not thenable", async () => {
    const s = stub(() => ({ __gwsPending: "s1" }));
    const r = await run(
      `async () => {
        const created = await sdk.drive.files.create({ requestBody: { name: "x" } });
        return {
          json: JSON.stringify(created.id),
          tpl: \`\${created.id}\`,
          str: String(created.files[0].id),
          root: \`\${created}\`,
          then: typeof created.then,
          concat: "id=" + created.id,
        };
      }`,
      s.call,
    );
    expect(returned(r)).toEqual({
      json: '"__gws_pending__:s1.id"',
      tpl: "__gws_pending__:s1.id",
      str: "__gws_pending__:s1.files.0.id",
      root: "__gws_pending__:s1",
      then: "undefined",
      concat: "id=__gws_pending__:s1.id",
    });
  });

  it("sends a pending field as its token in a dependent call's input", async () => {
    const s = stub((name) => (name === "drive.files.create" ? { __gwsPending: "s1" } : { __gwsPending: "s2" }));
    await run(
      `async () => {
        const created = await sdk.drive.files.create({ requestBody: { name: "x" } });
        await sdk.drive.permissions.create({ fileId: created.id, requestBody: { type: "anyone", role: "reader" } });
      }`,
      s.call,
    );
    expect(s.calls[1]).toEqual({
      name: "drive.permissions.create",
      input: { fileId: "__gws_pending__:s1.id", requestBody: { type: "anyone", role: "reader" } },
    });
  });

  it("returns a pending result as its token", async () => {
    const s = stub(() => ({ __gwsPending: "s3" }));
    const r = await run("async () => { const c = await sdk.docs.documents.create({}); return { c, id: c.documentId }; }", s.call);
    expect(returned(r)).toEqual({ c: "__gws_pending__:s3", id: "__gws_pending__:s3.documentId" });
  });

  it("does not dispatch when sdk paths are awaited, stringified or inspected", async () => {
    const s = stub();
    const r = await run(
      `async () => {
        const g = await sdk.gmail;
        const d = await sdk.drive.files;
        return {
          g: typeof g, d: typeof d,
          then: typeof sdk.gmail.then, toJSON: typeof sdk.toJSON, ctor: typeof sdk.drive.constructor,
          prim: typeof sdk[Symbol.toPrimitive], str: String(sdk), tpl: \`\${sdk.gmail.users}\`,
          json: JSON.stringify({ sdk }),
        };
      }`,
      s.call,
    );
    expect(returned(r)).toEqual({
      g: "function",
      d: "function",
      then: "undefined",
      toJSON: "undefined",
      ctor: "undefined",
      prim: "undefined",
      str: "sdk",
      tpl: "sdk.gmail.users",
      json: "{}",
    });
    expect(s.calls).toEqual([]);
  });

  it("keeps using the host call captured at start even if the snippet replaces __gws.call", async () => {
    const s = stub(() => ({ ok: true, value: 1 }));
    const r = await run("async () => { __gws.call = async () => ({ ok: true, value: 'hijacked' }); return sdk.a.b({}); }", s.call);
    expect(returned(r)).toBe(1);
    expect(s.calls).toHaveLength(1);
  });

  it("captures console output as logs", async () => {
    const r = await run("async () => { console.log('a', 1); console.warn('w'); console.error('e'); }", stub().call);
    expect(r).toEqual({ status: "returned", json: undefined, logs: ["a 1", "[warn] w", "[error] e"] });
  });
});
