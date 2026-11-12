import { describe, expect, it } from "vitest";
import { isDestructive, needsDrivePermissionLookup } from "../../src/core/destructive";

/**
 * The classifier reads every input field in any spelling Google's JSON parser accepts (camelCase or the proto's
 * snake_case), and flags changes to existing everyone or domain access rules.
 */
describe("isDestructive: field spellings", () => {
  const cases: Array<[string, unknown, string | undefined]> = [
    ["drive.permissions.create", { requestBody: { type: "user", role: "writer", emailAddress: "x@fake.test", pending_owner: true } }, "owner-transfer"],
    ["drive.permissions.create", { transfer_ownership: true, requestBody: { type: "user", role: "writer", email_address: "x@fake.test" } }, "owner-transfer"],
    ["drive.permissions.create", { requestBody: { type: "domain", role: "reader", domain: "x.test", allow_file_discovery: true } }, "public-share"],
    ["drive.permissions.create", { request_body: { type: "anyone", role: "reader" } }, "public-share"],
    ["drive.permissions.update", { permissionId: "p1", requestBody: { ROLE: "owner" } }, "owner-transfer"],
    ["calendar.acl.insert", { requestBody: { role: "reader", scope: { Type: "default" } } }, "public-share"],
    ["drive.files.update", { requestBody: { Trashed: true } }, "trash"],
    ["forms.forms.setPublishSettings", { requestBody: { publish_settings: { publish_state: { is_published: true } } } }, "public-share"],
    ["tasks.tasks.patch", { requestBody: { DELETED: true } }, "delete"],
    ["groupsSettings.groups.patch", { requestBody: { allow_external_members: "true" } }, "public-share"],
    ["tagmanager.accounts.containers.workspaces.bulk_update", { path: "accounts/1/containers/2/workspaces/3", requestBody: { changes: [{ change_status: "deleted" }] } }, "delete"],
    // A named person as writer stays a plain write (operator decision).
    ["drive.permissions.create", { requestBody: { type: "user", role: "writer", email_address: "x@fake.test" } }, undefined],
  ];
  for (const [fn, input, reason] of cases) {
    it(`${fn} ${JSON.stringify(input)} → ${reason ?? "not destructive"}`, () => {
      expect(isDestructive(fn, input).reason).toBe(reason);
    });
  }
});

describe("isDestructive: changes to everyone and domain access", () => {
  it("raising the role of the anyone-with-link permission is a public share; lowering it to reader is not", () => {
    expect(isDestructive("drive.permissions.update", { fileId: "f", permissionId: "anyoneWithLink", requestBody: { role: "writer" } }).reason).toBe("public-share");
    expect(isDestructive("drive.permissions.update", { fileId: "f", permissionId: "anyone", requestBody: { role: "commenter" } }).reason).toBe("public-share");
    expect(isDestructive("drive.permissions.update", { fileId: "f", permission_id: "ANYONEWITHLINK", requestBody: { allow_file_discovery: true } }).reason).toBe("public-share");
    expect(isDestructive("drive.permissions.update", { fileId: "f", permissionId: "anyoneWithLink", requestBody: { role: "reader" } }).destructive).toBe(false);
  });

  it("asks for a lookup when another permission's role is raised, and only then", () => {
    expect(needsDrivePermissionLookup("drive.permissions.update", { fileId: "f", permissionId: "123", requestBody: { role: "writer" } })).toBe(true);
    expect(needsDrivePermissionLookup("drive.permissions.update", { fileId: "f", permissionId: "123", requestBody: { role: "reader" } })).toBe(false);
    expect(needsDrivePermissionLookup("drive.permissions.update", { fileId: "f", permissionId: "anyoneWithLink", requestBody: { role: "writer" } })).toBe(false);
    expect(needsDrivePermissionLookup("drive.permissions.create", { fileId: "f", requestBody: { type: "user", role: "writer" } })).toBe(false);
  });

  it("changing the calendar's everyone or domain rule is a public share", () => {
    for (const fn of ["calendar.acl.patch", "calendar.acl.update"]) {
      expect(isDestructive(fn, { calendarId: "primary", ruleId: "default", requestBody: { role: "reader" } }).reason).toBe("public-share");
      expect(isDestructive(fn, { calendarId: "primary", rule_id: "domain:example.com", requestBody: {} }).reason).toBe("public-share");
      expect(isDestructive(fn, { calendarId: "primary", ruleId: "user:x@fake.test", requestBody: { role: "writer" } }).destructive).toBe(false);
    }
  });

  it("the calendar.share helper with public:true is a public share", () => {
    expect(isDestructive("calendar.share", { public: true, role: "reader" }).reason).toBe("public-share");
    expect(isDestructive("calendar.share", { email: "x@fake.test", role: "writer" }).destructive).toBe(false);
  });
});
