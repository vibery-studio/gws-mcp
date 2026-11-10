// Done 3: search returns signatures, effect and examples; one query per service (the five v1 services plus
// Forms, Tasks and Slides) finds the right method; at most 10 results under the byte cap.
import type { CheckResult, E2eContext, Recorder } from "../run";

const SEARCH_MAX_BYTES = 8000;
const MAX_RESULTS = 10;
/** A hit counts when the expected method is among the first few results. */
const MAX_RANK = 3;

/** One query per Forms, Tasks and Slides method that Done 16 reads or writes; Done 16 reuses them. */
export const NEW_SERVICE_QUERIES: ReadonlyArray<[string, string]> = [
  ["forms responses list", "forms.forms.responses.list"],
  ["tasks insert", "tasks.tasks.insert"],
  ["slides batchUpdate replace text", "slides.presentations.batchUpdate"],
];

const PER_SERVICE: ReadonlyArray<[string, string]> = [
  ["gmail messages list", "gmail.users.messages.list"],
  ["drive files list", "drive.files.list"],
  ["calendar events list", "calendar.events.list"],
  ["sheets values get", "sheets.spreadsheets.values.get"],
  ["docs documents get", "docs.documents.get"],
  ...NEW_SERVICE_QUERIES,
];

export default async function done03(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const first = await ctx.main.session.search("gmail messages list");
  const top = first.results[0];
  r.check(
    top !== undefined && top.signature.length > 0 && (top.effect === "read" || top.effect === "write") && top.example.length > 0,
    `search("gmail messages list") top=${top?.name ?? "none"} effect=${top?.effect ?? "-"} signature=${top?.signature.slice(0, 60) ?? "-"}`,
  );
  for (const [query, expected] of PER_SERVICE) {
    const { results, bytes, isError } = await ctx.main.session.search(query);
    const rank = results.findIndex((x) => x.name === expected) + 1;
    r.check(!isError && rank >= 1 && rank <= MAX_RANK, `search("${query}") -> ${expected} at rank ${rank || "none"}`);
    r.check(results.length <= MAX_RESULTS && bytes <= SEARCH_MAX_BYTES, `  results=${results.length} bytes=${bytes} (caps ${MAX_RESULTS}, ${SEARCH_MAX_BYTES})`);
  }
  return r.done();
}
