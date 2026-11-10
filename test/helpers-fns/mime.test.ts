import { describe, expect, it } from "vitest";
import { isGwsError } from "../../src/errors";
import { MAX_MESSAGE_BYTES, buildMime, encodeSubject, toRaw, type MimeInput } from "../../src/sdk/helpers/mime";

const DATE = new Date("2026-11-09T05:00:00Z");
const PDF_B64 = btoa("%PDF-1.4 hello");

function base(over: Partial<MimeInput> = {}): MimeInput {
  return {
    to: ["a@example.test"],
    subject: "Report",
    text: "Hello",
    attachments: [{ filename: "report.pdf", mimeType: "application/pdf", dataBase64: PDF_B64 }],
    ...over,
  };
}

function build(over: Partial<MimeInput> = {}, boundaries: string[] = ["B1", "B2"]): string {
  const queue = [...boundaries];
  return buildMime(base(over), { date: DATE, boundary: () => queue.shift() ?? "B-out" });
}

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    expect(isGwsError(e) && e.code).toBe("GWS_INVALID_INPUT");
    return;
  }
  throw new Error("expected GWS_INVALID_INPUT");
}

/** Decodes the RFC 2047 encoded words of a (folded) header value. */
function decodeWords(value: string): string {
  const words = [...value.replace(/\r\n /g, " ").matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)];
  return words.map((m) => new TextDecoder().decode(Uint8Array.from(atob(m[1] ?? ""), (c) => c.charCodeAt(0)))).join("");
}

describe("buildMime", () => {
  it("matches a known message byte for byte", () => {
    expect(build()).toBe(
      [
        "MIME-Version: 1.0",
        "Date: Mon, 09 Nov 2026 05:00:00 +0000",
        "To: a@example.test",
        "Subject: Report",
        'Content-Type: multipart/mixed; boundary="B1"',
        "",
        "--B1",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        "SGVsbG8=",
        "--B1",
        'Content-Type: application/pdf; name="report.pdf"',
        'Content-Disposition: attachment; filename="report.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        PDF_B64,
        "--B1--",
        "",
      ].join("\r\n"),
    );
  });

  it("nests text and html in multipart/alternative with its own boundary", () => {
    const m = build({ html: "<b>Hello</b>" });
    expect(m).toContain('Content-Type: multipart/alternative; boundary="B1"');
    expect(m).toContain('Content-Type: multipart/mixed; boundary="B2"');
    expect(m.indexOf("text/plain")).toBeLessThan(m.indexOf("text/html"));
    expect(m).toContain("--B1--\r\n");
  });

  it("sends html alone as text/html", () => {
    const m = build({ text: undefined, html: "<p>x</p>" });
    expect(m).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(m).not.toContain("text/plain");
  });

  it("joins several recipients and adds Cc", () => {
    const m = build({ to: ["a@example.test", "b@example.test"], cc: ["c@example.test"] });
    expect(m).toContain("To: a@example.test, b@example.test\r\n");
    expect(m).toContain("Cc: c@example.test\r\n");
  });

  it("wraps attachment base64 at 76 characters with CRLF", () => {
    const bytes = Uint8Array.from({ length: 200 }, (_, i) => i);
    const data = btoa(String.fromCharCode(...bytes));
    const m = build({ attachments: [{ filename: "a.bin", mimeType: "application/octet-stream", dataBase64: data }] });
    const body = m.split("Content-Transfer-Encoding: base64\r\n\r\n")[2]?.split("\r\n--B1--")[0] ?? "";
    const lines = body.split("\r\n");
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines.slice(0, -1)) expect(l).toHaveLength(76);
    expect(lines.at(-1)?.length).toBeLessThanOrEqual(76);
    expect(lines.join("")).toBe(data);
  });

  it("keeps every line of the message ASCII and within 998 characters", () => {
    const m = build({ subject: "Báo cáo tháng 11", text: "Xin chào, đây là báo cáo ✓" });
    for (const line of m.split("\r\n")) {
      expect(line).toMatch(/^[\x20-\x7e\t]*$/);
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });

  it("round-trips a UTF-8 body through base64", () => {
    const m = build({ text: "Xin chào ✓" });
    const b64 = m.split("Content-Transfer-Encoding: base64\r\n\r\n")[1]?.split("\r\n--B1")[0] ?? "";
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).toBe("Xin chào ✓");
  });

  it("encodes a non-ASCII filename per RFC 2231 with an ASCII fallback", () => {
    const m = build({ attachments: [{ filename: 'Báo "cáo".pdf', mimeType: "application/pdf", dataBase64: PDF_B64 }] });
    expect(m).toContain("filename*=UTF-8''B%C3%A1o%20%22c%C3%A1o%22.pdf");
    expect(m).toContain('filename="B_o _c_o_.pdf"');
  });
});

describe("encodeSubject", () => {
  it("leaves an ASCII subject as is", () => {
    expect(encodeSubject("Weekly report #4")).toBe("Weekly report #4");
  });

  it("encodes a Vietnamese subject as RFC 2047 UTF-8 base64 words", () => {
    const out = encodeSubject("Báo cáo");
    expect(out).toBe("=?UTF-8?B?QsOhbyBjw6Fv?=");
    expect(decodeWords(out)).toBe("Báo cáo");
  });

  it("splits a long subject into words of at most 75 characters without breaking a character", () => {
    const subject = "Báo cáo tình hình kinh doanh quý ba năm hai nghìn không trăm hai mươi sáu — gửi ban giám đốc để xem xét ✓";
    const out = encodeSubject(subject);
    const words = out.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w.length).toBeLessThanOrEqual(75);
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
    expect(decodeWords(out)).toBe(subject);
  });
});

describe("header injection", () => {
  const cases: Array<[string, Partial<MimeInput>]> = [
    ["CRLF in the subject", { subject: "Hi\r\nBcc: evil@example.test" }],
    ["LF in the subject", { subject: "Hi\nBcc: evil@example.test" }],
    ["CR in the subject", { subject: "Hi\rBcc: evil@example.test" }],
    ["CRLF in a non-ASCII subject", { subject: "Chào\r\nBcc: evil@example.test" }],
    ["NUL in the subject", { subject: "Hi\u0000" }],
    ["CRLF in a recipient", { to: ["a@example.test\r\nBcc: evil@example.test"] }],
    ["CRLF in a cc", { cc: ["a@example.test\nBcc: evil@example.test"] }],
    ["CRLF in a filename", { attachments: [{ filename: "a\r\nX-Evil: 1.pdf", mimeType: "application/pdf", dataBase64: PDF_B64 }] }],
    ["CRLF in a mime type", { attachments: [{ filename: "a.pdf", mimeType: "text/plain\r\nX-Evil: 1", dataBase64: PDF_B64 }] }],
    ["a mime type with parameters", { attachments: [{ filename: "a.pdf", mimeType: "text/plain; boundary=x", dataBase64: PDF_B64 }] }],
  ];

  it.each(cases)("rejects %s", (_name, over) => {
    expectInvalid(() => build(over));
  });

  it("rejects a recipient that is not a bare address", () => {
    for (const bad of ["not-an-address", "a@b@example.test", "Name <a@example.test>", "a@example.test, b@example.test", "a b@example.test"]) {
      expectInvalid(() => build({ to: [bad] }));
    }
  });

  it("rejects a message without recipients, body or valid base64", () => {
    expectInvalid(() => build({ to: [] }));
    expectInvalid(() => build({ text: undefined, html: undefined }));
    expectInvalid(() => build({ attachments: [{ filename: "a.pdf", mimeType: "application/pdf", dataBase64: "not base64!" }] }));
  });
});

describe("boundary", () => {
  it("never uses a boundary that occurs in the content", () => {
    // Zero bytes encode to a run of "A": the first candidate collides with the attachment.
    const zeros = btoa("\u0000".repeat(60));
    const m = build({ attachments: [{ filename: "z.bin", mimeType: "application/octet-stream", dataBase64: zeros }] }, ["AAAAAAAA", "safe-one"]);
    expect(m).toContain('boundary="safe-one"');
    expect(m).not.toContain('boundary="AAAAAAAA"');
  });

  it("generates a different random boundary each time", () => {
    const a = buildMime(base(), { date: DATE });
    const b = buildMime(base(), { date: DATE });
    const boundary = (m: string) => /boundary="([^"]+)"/.exec(m)?.[1] ?? "";
    expect(boundary(a)).not.toBe(boundary(b));
    expect(boundary(a).length).toBeGreaterThanOrEqual(20);
    expect(boundary(a)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("size limit", () => {
  it("rejects a message above 25 MB before decoding the attachments", () => {
    const big = "A".repeat(Math.ceil((MAX_MESSAGE_BYTES * 3) / 4 / 3) * 4 + 4);
    expectInvalid(() => build({ attachments: [{ filename: "big.bin", mimeType: "application/octet-stream", dataBase64: big }] }));
  });
});

describe("toRaw", () => {
  it("is URL-safe base64 without padding", () => {
    expect(toRaw("???>>>")).toBe("Pz8_Pj4-");
    expect(toRaw("a")).toBe("YQ");
  });
});
