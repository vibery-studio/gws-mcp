import { GwsError } from "../errors";

export interface Page<T> {
  items: T[];
  nextPageToken?: string;
}

export interface PaginateResult<T> {
  items: T[];
  pages: number;
  /** True when a limit stopped the walk while more data existed. */
  truncated: boolean;
  /** Token to resume from; only set when resuming would skip nothing (the walk stopped on a page boundary). */
  nextPageToken?: string;
}

function positiveInt(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 1) throw new GwsError("GWS_INTERNAL", `paginate: ${name} must be a positive integer`);
}

/**
 * Follows `nextPageToken` up to `maxPages` pages and `maxItems` items. For helpers only: raw SDK method
 * calls return one page, exactly as Google does.
 */
export async function paginate<T>(
  callPage: (pageToken?: string) => Promise<Page<T>>,
  opts: { maxPages: number; maxItems: number },
): Promise<PaginateResult<T>> {
  positiveInt("maxPages", opts.maxPages);
  positiveInt("maxItems", opts.maxItems);
  const items: T[] = [];
  let token: string | undefined;
  let pages = 0;
  while (true) {
    const page = await callPage(token);
    pages++;
    const room = opts.maxItems - items.length;
    items.push(...page.items.slice(0, room));
    const cutMidPage = page.items.length > room;
    token = page.nextPageToken || undefined;
    if (cutMidPage) return { items, pages, truncated: true };
    if (token === undefined) return { items, pages, truncated: false };
    if (pages >= opts.maxPages || items.length >= opts.maxItems) return { items, pages, truncated: true, nextPageToken: token };
  }
}
