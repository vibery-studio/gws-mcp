import { describe, expect, it } from "vitest";
import { GwsError } from "../../src/errors";
import { paginate, type Page } from "../../src/google/paginate";

/** A source of `total` numbered items served `size` per page, recording every token it was asked for. */
function source(total: number, size: number) {
  const asked: Array<string | undefined> = [];
  const callPage = async (pageToken?: string): Promise<Page<number>> => {
    asked.push(pageToken);
    const start = pageToken === undefined ? 0 : Number(pageToken);
    const items = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => start + i);
    const next = start + size;
    return next < total ? { items, nextPageToken: String(next) } : { items };
  };
  return { asked, callPage };
}

describe("paginate", () => {
  it("follows nextPageToken until the last page", async () => {
    const s = source(7, 3);
    const out = await paginate(s.callPage, { maxPages: 10, maxItems: 100 });
    expect(out).toEqual({ items: [0, 1, 2, 3, 4, 5, 6], pages: 3, truncated: false });
    expect(s.asked).toEqual([undefined, "3", "6"]);
  });

  it("stops at maxPages and returns the token to resume from", async () => {
    const s = source(100, 10);
    const out = await paginate(s.callPage, { maxPages: 2, maxItems: 1000 });
    expect(out).toEqual({ items: Array.from({ length: 20 }, (_, i) => i), pages: 2, truncated: true, nextPageToken: "20" });
    expect(s.asked).toEqual([undefined, "10"]);
  });

  it("stops at maxItems mid-page without a resume token", async () => {
    const s = source(100, 10);
    const out = await paginate(s.callPage, { maxPages: 10, maxItems: 15 });
    expect(out.items).toEqual(Array.from({ length: 15 }, (_, i) => i));
    expect(out).toMatchObject({ pages: 2, truncated: true });
    expect(out.nextPageToken).toBeUndefined();
  });

  it("returns a resume token when maxItems ends exactly on a page boundary", async () => {
    const s = source(100, 10);
    const out = await paginate(s.callPage, { maxPages: 10, maxItems: 20 });
    expect(out).toMatchObject({ pages: 2, truncated: true, nextPageToken: "20" });
    expect(out.items).toHaveLength(20);
  });

  it("is not truncated when the limits end with the data", async () => {
    const s = source(20, 10);
    expect(await paginate(s.callPage, { maxPages: 2, maxItems: 20 })).toMatchObject({ pages: 2, truncated: false });
  });

  it("treats an empty nextPageToken as the end", async () => {
    let calls = 0;
    const out = await paginate(
      async () => {
        calls++;
        return { items: ["a"], nextPageToken: "" };
      },
      { maxPages: 5, maxItems: 5 },
    );
    expect(calls).toBe(1);
    expect(out).toEqual({ items: ["a"], pages: 1, truncated: false });
  });

  it.each([
    [{ maxPages: 0, maxItems: 1 }],
    [{ maxPages: 1, maxItems: 0 }],
    [{ maxPages: 1.5, maxItems: 1 }],
    [{ maxPages: Number.POSITIVE_INFINITY, maxItems: 1 }],
  ])("rejects invalid limits %j", async (opts) => {
    await expect(paginate(source(1, 1).callPage, opts)).rejects.toBeInstanceOf(GwsError);
  });

  it("propagates a page error without calling further pages", async () => {
    let calls = 0;
    const err = new GwsError("GWS_UPSTREAM_ERROR", "boom", { details: { status: 500 } });
    await expect(
      paginate(
        async () => {
          calls++;
          throw err;
        },
        { maxPages: 3, maxItems: 10 },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });
});
