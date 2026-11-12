import { describe, expect, it } from "vitest";
import { DESTRUCTIVE_REASON_WORDS, describeDestructiveReasons, isDestructive, type DestructiveReason } from "../../src/core/destructive";
import { EXECUTE_DESCRIPTION } from "../../src/core/tools";

/** One method (and input) of each reason class. */
const SAMPLE: Readonly<Record<DestructiveReason, [string, unknown?]>> = {
  delete: ["drive.files.delete"],
  trash: ["gmail.users.messages.trash"],
  "empty-trash": ["drive.files.emptyTrash"],
  clear: ["sheets.spreadsheets.values.clear"],
  "public-share": ["drive.permissions.create", { requestBody: { type: "anyone", role: "reader" } }],
  "owner-transfer": ["calendar.calendars.transferOwnership"],
  disconnect: ["accounts.disconnect"],
  publish: ["tagmanager.accounts.containers.versions.publish"],
  "permission-change": ["tagmanager.accounts.user_permissions.create"],
  spend: ["googleads.customers.campaigns.mutate"],
};

describe("destructive reasons", () => {
  it("gives every reason plain words", () => {
    for (const reason of Object.keys(SAMPLE) as DestructiveReason[]) {
      expect(DESTRUCTIVE_REASON_WORDS[reason], reason).toMatch(/^[a-z][A-Za-z ]+[a-z]$/);
    }
    expect(Object.keys(DESTRUCTIVE_REASON_WORDS).sort()).toEqual(Object.keys(SAMPLE).sort());
  });

  it("classifies a sample method of each reason", () => {
    for (const [reason, [fn, input]] of Object.entries(SAMPLE) as [DestructiveReason, [string, unknown?]][]) {
      expect(isDestructive(fn, input), fn).toEqual({ destructive: true, reason });
    }
  });

  it("lists every reason with its words in the execute description", () => {
    expect(describeDestructiveReasons()).toBe(
      Object.entries(DESTRUCTIVE_REASON_WORDS)
        .map(([r, w]) => `${r} (${w})`)
        .join(", "),
    );
    for (const [reason, words] of Object.entries(DESTRUCTIVE_REASON_WORDS)) expect(EXECUTE_DESCRIPTION).toContain(`${reason} (${words})`);
  });
});
