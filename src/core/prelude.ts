import { PENDING_TOKEN_PREFIX } from "../contracts";

/**
 * Sandbox-side JavaScript run before every snippet, after the executor has defined the flat `__gws`
 * provider (its single fn `call(name, input)` reaches the host dispatcher over RPC). It defines:
 *
 * - `GwsError`: what a failed SDK call throws. The message starts with `<code>: `; `code`, `details`, `fn`
 *   and `account` carry the structured error. A host-side failure only ever arrives as such a code.
 * - `sdk`: a nested path proxy. `sdk.gmail.users.messages.list(input)` calls
 *   `__gws.call("gmail.users.messages.list", input ?? {})`. Reading `then`, `toJSON`, `constructor`,
 *   `valueOf` or any symbol gives `undefined`, so `await sdk.gmail` or stringifying `sdk` never dispatches.
 *   It holds nothing but path strings.
 * - Pending proxies: a dry-run write returns one instead of a value. Any field of it is another pending
 *   proxy, and every one serializes (JSON, template literal, String) to `__gws_pending__:sN.<path>`, so a
 *   later call that uses it is planned as incomplete by the dispatcher. It is not thenable.
 *
 * Plain JavaScript without imports: it is spliced into the executor's module source.
 */
export const SDK_PRELUDE = String.raw`
    class GwsError extends Error {
      constructor(e) {
        const err = e !== null && typeof e === "object" ? e : {};
        const code = typeof err.code === "string" ? err.code : "GWS_INTERNAL";
        super(code + ": " + (typeof err.message === "string" ? err.message : "internal error"));
        this.name = "GwsError";
        this.code = code;
        this.details = err.details;
        if (err.fn !== undefined) this.fn = err.fn;
        if (err.account !== undefined) this.account = err.account;
      }
    }
    const __gwsCall = __gws.call;
    const __gwsPendingProxy = (path) => {
      const token = ${JSON.stringify(PENDING_TOKEN_PREFIX)} + path;
      const asToken = () => token;
      return new Proxy({}, {
        get: (_target, prop) => {
          if (prop === Symbol.toPrimitive || prop === "toJSON" || prop === "toString" || prop === "valueOf") return asToken;
          if (typeof prop !== "string" || prop === "then") return undefined;
          return __gwsPendingProxy(path + "." + prop);
        },
      });
    };
    const __gwsUnwrap = (res) => {
      if (res !== null && typeof res === "object") {
        if ("__gwsError" in res) throw new GwsError(res.__gwsError);
        if (typeof res.__gwsPending === "string") return __gwsPendingProxy(res.__gwsPending);
        if (res.ok === true) return res.value;
      }
      throw new GwsError({ code: "GWS_INTERNAL", message: "malformed SDK response" });
    };
    const __gwsSdkPath = (path) => new Proxy(function () {}, {
      get: (_target, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "toJSON" || prop === "constructor" || prop === "valueOf") return undefined;
        if (prop === "toString") return () => (path.length === 0 ? "sdk" : "sdk." + path.join("."));
        return __gwsSdkPath([...path, prop]);
      },
      apply: (_target, _this, args) => (async () => __gwsUnwrap(await __gwsCall(path.join("."), args[0] ?? {})))(),
    });
    const sdk = __gwsSdkPath([]);
`;
