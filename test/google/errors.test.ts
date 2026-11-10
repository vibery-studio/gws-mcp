import { describe, expect, it } from "vitest";
import { toWire } from "../../src/errors";
import { mapUpstreamError } from "../../src/google/errors";

const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
const REQUEST_INFO = "type.googleapis.com/google.rpc.RequestInfo";

function envelope(error: Record<string, unknown>): string {
  return JSON.stringify({ error });
}

describe("mapUpstreamError", () => {
  it("maps a Google error envelope to GWS_UPSTREAM_ERROR with status, reason and googleStatus", () => {
    const e = mapUpstreamError(
      404,
      envelope({
        code: 404,
        message: "File not found: abc.",
        status: "NOT_FOUND",
        errors: [{ message: "File not found: abc.", domain: "global", reason: "notFound" }],
      }),
    );
    expect(e.code).toBe("GWS_UPSTREAM_ERROR");
    expect(e.details).toEqual({ status: 404, reason: "notFound", googleStatus: "NOT_FOUND" });
  });

  it("prefers the ErrorInfo reason and carries the RequestInfo request id", () => {
    const e = mapUpstreamError(
      429,
      envelope({
        code: 429,
        message: "Quota exceeded",
        status: "RESOURCE_EXHAUSTED",
        errors: [{ reason: "rateLimitExceeded" }],
        details: [
          { "@type": ERROR_INFO, reason: "RATE_LIMIT_EXCEEDED", domain: "googleapis.com" },
          { "@type": REQUEST_INFO, requestId: "req-0123456789abcdef" },
        ],
      }),
    );
    expect(e.code).toBe("GWS_UPSTREAM_ERROR");
    expect(e.details).toEqual({
      status: 429,
      reason: "RATE_LIMIT_EXCEEDED",
      googleStatus: "RESOURCE_EXHAUSTED",
      requestId: "req-0123456789abcdef",
    });
  });

  it("maps 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT to GWS_SCOPE_MISSING", () => {
    const e = mapUpstreamError(
      403,
      envelope({
        code: 403,
        message: "Request had insufficient authentication scopes.",
        status: "PERMISSION_DENIED",
        errors: [{ reason: "insufficientPermissions" }],
        details: [{ "@type": ERROR_INFO, reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", domain: "googleapis.com" }],
      }),
    );
    expect(e.code).toBe("GWS_SCOPE_MISSING");
    expect(e.details).toEqual({ status: 403, reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", googleStatus: "PERMISSION_DENIED" });
  });

  it("keeps other 403 reasons as GWS_UPSTREAM_ERROR", () => {
    const e = mapUpstreamError(403, envelope({ code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "forbidden" }] }));
    expect(e.code).toBe("GWS_UPSTREAM_ERROR");
    expect(e.details).toEqual({ status: 403, reason: "forbidden", googleStatus: "PERMISSION_DENIED" });
  });

  it("maps a non-JSON 502 to GWS_UPSTREAM_ERROR with the status only", () => {
    const e = mapUpstreamError(502, "<html><body>Bad Gateway</body></html>");
    expect(e.code).toBe("GWS_UPSTREAM_ERROR");
    expect(e.details).toEqual({ status: 502 });
    expect(e.message).toBe("Google API error 502");
  });

  it("treats JSON without an error object like a non-JSON body", () => {
    expect(mapUpstreamError(500, '{"oops":true}').details).toEqual({ status: 500 });
    expect(mapUpstreamError(500, '{"error":"invalid_grant"}').details).toEqual({ status: 500 });
    expect(mapUpstreamError(500, "").details).toEqual({ status: 500 });
  });

  it("describes the error in the message from status, googleStatus and reason only", () => {
    const e = mapUpstreamError(404, envelope({ code: 404, message: "File not found: abc.", status: "NOT_FOUND", errors: [{ reason: "notFound" }] }));
    expect(e.message).toBe("Google API error 404 NOT_FOUND (notFound)");
  });
});

describe("upstream bodies never reach the wire", () => {
  const MARK = "UPSTREAM-BODY-MARKER";

  it.each([
    ["error.message", envelope({ code: 400, message: `bad ${MARK}`, status: "INVALID_ARGUMENT" })],
    ["errors[].message", envelope({ code: 400, status: "INVALID_ARGUMENT", errors: [{ message: MARK, reason: "invalid" }] })],
    ["errors[].location", envelope({ code: 400, errors: [{ reason: "invalid", location: MARK, locationType: "parameter" }] })],
    ["ErrorInfo.metadata", envelope({ code: 400, details: [{ "@type": ERROR_INFO, reason: "BAD", metadata: { x: MARK } }] })],
    ["another detail type", envelope({ code: 400, details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ description: MARK }] }] })],
    ["a free-text reason", envelope({ code: 400, errors: [{ reason: `not a reason ${MARK}` }] })],
    ["a free-text status", envelope({ code: 400, status: `bad status ${MARK}` })],
    ["a free-text request id", envelope({ code: 400, details: [{ "@type": REQUEST_INFO, requestId: `id with spaces ${MARK}` }] })],
    ["an oversized reason", envelope({ code: 400, errors: [{ reason: `R${"x".repeat(200)}${MARK}` }] })],
    ["a non-JSON body", `<html>${MARK}</html>`],
  ])("drops %s", (_where, body) => {
    const e = mapUpstreamError(400, body);
    const wire = JSON.stringify(toWire(e));
    expect(wire).not.toContain(MARK);
    expect(e.message).not.toContain(MARK);
    for (const key of Object.keys(e.details ?? {})) {
      expect(["status", "reason", "googleStatus", "requestId"]).toContain(key);
    }
  });
});
