import { describe, expect, it } from "vitest";
import groupsGet from "../../fake-google/fixtures/groups/groups-get.json";
import groupsList from "../../fake-google/fixtures/groups/groups-list.json";
import membersInsert from "../../fake-google/fixtures/groups/members-insert.json";
import membersList from "../../fake-google/fixtures/groups/members-list.json";
import settingsGet from "../../fake-google/fixtures/groups/settings-get.json";
import settingsPatch from "../../fake-google/fixtures/groups/settings-patch.json";
import { DoStore } from "../../fake-google/src/do-store";
import { parseFixture } from "../../fake-google/src/fixtures";
import { routes } from "../../fake-google/src/routes/groups";
import { G, account, api, callRoute, expectRouteScopes, json, memoryBackend, outputSchema, replay, send, type GoogleErrorBody } from "./support";

const GROUP = `${G}admin.directory.group`;
const GROUP_RO = `${G}admin.directory.group.readonly`;
const MEMBER = `${G}admin.directory.group.member`;
const MEMBER_RO = `${G}admin.directory.group.member.readonly`;
const SETTINGS = `${G}apps.groups.settings`;
const DIR = "/admin.googleapis.com/admin/directory/v1/groups";
const SET = "/www.googleapis.com/groups/v1/groups";
const TEAM = "seed-group-team";
const ENG = "seed-group-eng";

interface Group {
  id: string;
  email: string;
  name: string;
  description?: string;
  directMembersCount: string;
}
interface Member {
  id: string;
  email: string;
  role: string;
  type: string;
  status: string;
}
interface GroupList {
  groups?: Group[];
  nextPageToken?: string;
}
interface MemberList {
  members?: Member[];
  nextPageToken?: string;
}

const addMember = (token: string, group: string, body: unknown) => send(token, "POST", `${DIR}/${group}/members`, body);
const members = (token: string, group: string, query = "") => json<MemberList>(api(token, `${DIR}/${group}/members${query}`));

describe("scopes", () => {
  const CASES = [
    { fn: "directory.groups.list", method: "GET", path: DIR },
    { fn: "directory.groups.get", method: "GET", path: `${DIR}/${TEAM}` },
    { fn: "directory.members.list", method: "GET", path: `${DIR}/${TEAM}/members` },
    { fn: "directory.members.insert", method: "POST", path: `${DIR}/${TEAM}/members` },
    { fn: "directory.members.delete", method: "DELETE", path: `${DIR}/${TEAM}/members/dana@fake.test` },
    { fn: "groupsSettings.groups.get", method: "GET", path: `${SET}/team@fake.test` },
    { fn: "groupsSettings.groups.patch", method: "PATCH", path: `${SET}/team@fake.test` },
  ] as const;

  it("requires exactly the Discovery scopes of each method", () => {
    expectRouteScopes(routes, CASES);
  });

  it("refuses each route for a token without any of its scopes", async () => {
    const { token } = await account([`${G}calendar.events`]);
    for (const c of CASES) {
      const res = await api(token, c.path, { method: c.method });
      expect(res.status, `${c.method} ${c.path}`).toBe(403);
      expect(((await res.json()) as GoogleErrorBody).error.details?.[0]?.reason).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
  });

  it("separates reading groups, managing members and group settings", async () => {
    const { token: ro } = await account([GROUP_RO]);
    expect((await api(ro, DIR)).status).toBe(200);
    expect((await api(ro, `${DIR}/${TEAM}/members`)).status).toBe(200);
    expect((await addMember(ro, TEAM, { email: "new@fake.test" })).status).toBe(403);
    expect((await api(ro, `${SET}/team@fake.test`)).status).toBe(403);

    const { token: memberOnly } = await account([MEMBER_RO]);
    expect((await api(memberOnly, `${DIR}/${TEAM}/members`)).status).toBe(200);
    expect((await api(memberOnly, DIR)).status).toBe(403);

    const { token: settings } = await account([SETTINGS]);
    expect((await api(settings, `${SET}/team@fake.test`)).status).toBe(200);
    expect((await api(settings, DIR)).status).toBe(403);
  });
});

describe("directory groups", () => {
  it("lists the seeded groups by email", async () => {
    const { token } = await account([GROUP_RO]);
    const list = await json<GroupList & { kind: string }>(api(token, DIR));
    expect(list.kind).toBe("admin#directory#groups");
    expect(list.groups?.map((g) => g.email)).toEqual(["eng@fake.test", "team@fake.test"]);
    expect(outputSchema("directory.groups.list").safeParse(list).success).toBe(true);
    const desc = await json<GroupList>(api(token, `${DIR}?sortOrder=DESCENDING&orderBy=email`));
    expect(desc.groups?.map((g) => g.email)).toEqual(["team@fake.test", "eng@fake.test"]);
  });

  it("filters by domain and by member", async () => {
    const { token } = await account([GROUP_RO]);
    expect((await json<GroupList>(api(token, `${DIR}?domain=fake.test`))).groups).toHaveLength(2);
    expect((await json<GroupList>(api(token, `${DIR}?domain=other.test`))).groups).toBeUndefined();
    expect((await json<GroupList>(api(token, `${DIR}?userKey=dana@fake.test`))).groups?.map((g) => g.id)).toEqual([TEAM]);
    expect((await json<GroupList>(api(token, `${DIR}?userKey=erin@fake.test`))).groups?.map((g) => g.id)).toEqual([ENG, TEAM]);
  });

  it("pages with maxResults and pageToken", async () => {
    const { token } = await account([GROUP_RO]);
    const first = await json<GroupList>(api(token, `${DIR}?maxResults=1`));
    expect(first.groups?.map((g) => g.id)).toEqual([ENG]);
    const second = await json<GroupList>(api(token, `${DIR}?maxResults=1&pageToken=${first.nextPageToken}`));
    expect(second.groups?.map((g) => g.id)).toEqual([TEAM]);
    expect(second.nextPageToken).toBeUndefined();
    for (const q of ["maxResults=0", "maxResults=201", "maxResults=x", "pageToken=abc", "query=name:x", "sortOrder=SIDEWAYS", "orderBy=name"]) {
      expect((await api(token, `${DIR}?${q}`)).status, q).toBe(400);
    }
  });

  it("gets a group by id or by email, and answers 404 for an unknown one", async () => {
    const { token } = await account([GROUP_RO]);
    const byId = await json<Group>(api(token, `${DIR}/${TEAM}`));
    expect(byId).toMatchObject({ id: TEAM, email: "team@fake.test", name: "Team", directMembersCount: "3" });
    expect(await json(api(token, `${DIR}/team@fake.test`))).toEqual(byId);
    expect(await json(api(token, `${DIR}/TEAM@fake.test`))).toEqual(byId);
    expect(outputSchema("directory.groups.get").safeParse(byId).success).toBe(true);
    const missing = await json<GoogleErrorBody>(api(token, `${DIR}/nobody@fake.test`), 404);
    expect(missing.error.message).toBe("Resource Not Found: groupKey");
    expect(missing.error.errors?.[0]?.reason).toBe("notFound");
  });
});

describe("directory members", () => {
  it("lists members, owners first and then by email, filtered by role and paged", async () => {
    const { email, token } = await account([MEMBER_RO]);
    const all = await members(token, TEAM);
    expect(all.members?.map((m) => [m.email, m.role])).toEqual([
      [email, "OWNER"],
      ["dana@fake.test", "MEMBER"],
      ["erin@fake.test", "MEMBER"],
    ]);
    expect(all.members?.[0]).toMatchObject({ type: "USER", status: "ACTIVE" });
    expect(outputSchema("directory.members.list").safeParse(all).success).toBe(true);
    expect((await members(token, TEAM, "?roles=OWNER")).members?.map((m) => m.email)).toEqual([email]);
    expect((await members(token, TEAM, "?roles=OWNER,MANAGER")).members?.map((m) => m.email)).toEqual([email]);
    const first = await members(token, TEAM, "?maxResults=2");
    expect(first.members).toHaveLength(2);
    const rest = await members(token, TEAM, `?maxResults=2&pageToken=${first.nextPageToken}`);
    expect([...(first.members ?? []), ...(rest.members ?? [])]).toEqual(all.members);
    expect((await api(token, `${DIR}/${TEAM}/members?roles=BOSS`)).status).toBe(400);
    expect((await api(token, `${DIR}/nope/members`)).status).toBe(404);
  });

  it("inserts a member, which the next list and group count show", async () => {
    const { token } = await account([GROUP, MEMBER]);
    const added = await json<Member>(addMember(token, TEAM, { email: "Gwen@fake.test", role: "MANAGER" }));
    expect(added).toMatchObject({ email: "gwen@fake.test", role: "MANAGER", type: "USER", status: "ACTIVE" });
    expect(outputSchema("directory.members.insert").safeParse(added).success).toBe(true);
    expect((await members(token, TEAM)).members?.map((m) => m.email)).toContain("gwen@fake.test");
    expect((await json<Group>(api(token, `${DIR}/${TEAM}`))).directMembersCount).toBe("4");
    const defaulted = await json<Member>(addMember(token, ENG, { email: "hana@fake.test" }));
    expect(defaulted.role).toBe("MEMBER");
  });

  it("refuses a duplicate with 409, and bad input with 400", async () => {
    const { token } = await account([MEMBER]);
    const dup = await json<GoogleErrorBody>(addMember(token, TEAM, { email: "dana@fake.test" }), 409);
    expect(dup.error.message).toBe("Member already exists.");
    expect(dup.error.errors?.[0]?.reason).toBe("duplicate");
    for (const body of [{}, { email: "nope" }, { email: "a@fake.test", role: "BOSS" }, { email: "a@fake.test", type: "ROBOT" }]) {
      expect((await addMember(token, TEAM, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await addMember(token, "nope", { email: "a@fake.test" })).status).toBe(404);
    expect((await members(token, TEAM)).members).toHaveLength(3);
  });

  it("deletes a member by email, with 404 the second time", async () => {
    const { token } = await account([MEMBER, GROUP]);
    const del = await api(token, `${DIR}/${TEAM}/members/dana@fake.test`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect((await members(token, TEAM)).members?.map((m) => m.email)).not.toContain("dana@fake.test");
    expect((await json<Group>(api(token, `${DIR}/${TEAM}`))).directMembersCount).toBe("2");
    const again = await json<GoogleErrorBody>(api(token, `${DIR}/${TEAM}/members/dana@fake.test`, { method: "DELETE" }), 404);
    expect(again.error.message).toBe("Resource Not Found: memberKey");
    expect((await api(token, `${DIR}/nope/members/dana@fake.test`, { method: "DELETE" })).status).toBe(404);
  });

  it("deletes a member by its id too", async () => {
    const { token } = await account([MEMBER]);
    const { members: list } = await members(token, ENG);
    const target = list?.find((m) => m.email === "frank@fake.test");
    expect(target?.id).toBeTruthy();
    expect((await api(token, `${DIR}/${ENG}/members/${target?.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await members(token, ENG)).members?.map((m) => m.email)).toEqual(["erin@fake.test"]);
  });

  it("keeps each group's members apart", async () => {
    const { token } = await account([MEMBER]);
    await addMember(token, ENG, { email: "only-eng@fake.test" });
    expect((await members(token, TEAM)).members?.map((m) => m.email)).not.toContain("only-eng@fake.test");
  });
});

describe("group settings", () => {
  const get = (token: string, key = "team@fake.test") => json<Record<string, unknown>>(api(token, `${SET}/${key}?alt=json`));
  const patch = (token: string, body: unknown, key = "team@fake.test") => send(token, "PATCH", `${SET}/${key}`, body);

  it("reads the settings of a group by email, with booleans as strings", async () => {
    const { token } = await account([SETTINGS]);
    const s = await get(token);
    expect(s).toMatchObject({ kind: "groupsSettings#groups", email: "team@fake.test", name: "Team", whoCanJoin: "INVITED_CAN_JOIN", allowExternalMembers: "false" });
    expect(outputSchema("groupsSettings.groups.get").safeParse(s).success).toBe(true);
    expect((await get(token, "eng@fake.test")).whoCanJoin).toBe("CAN_REQUEST_TO_JOIN");
  });

  it("patches settings, leaving the rest, and the next get shows them", async () => {
    const { token } = await account([SETTINGS]);
    const before = await get(token);
    const patched = await json<Record<string, unknown>>(patch(token, { whoCanJoin: "ANYONE_CAN_JOIN", allowExternalMembers: "true", description: "Open to all" }));
    expect(patched).toMatchObject({ whoCanJoin: "ANYONE_CAN_JOIN", allowExternalMembers: "true", description: "Open to all" });
    expect(outputSchema("groupsSettings.groups.patch").safeParse(patched).success).toBe(true);
    expect(await get(token)).toEqual({ ...before, whoCanJoin: "ANYONE_CAN_JOIN", allowExternalMembers: "true", description: "Open to all" });
    expect((await get(token, "eng@fake.test")).whoCanJoin).toBe("CAN_REQUEST_TO_JOIN");
  });

  it("refuses unknown settings, bad values and a non-object body", async () => {
    const { token } = await account([SETTINGS]);
    for (const body of [{ nonsense: "x" }, { whoCanJoin: "EVERYONE" }, { allowExternalMembers: true }, { allowWebPosting: "maybe" }, { name: 5 }, { email: "x@fake.test" }]) {
      const res = await json<GoogleErrorBody>(patch(token, body), 400);
      expect(res.error.status, JSON.stringify(body)).toBe("INVALID_ARGUMENT");
    }
    expect((await get(token)).whoCanJoin).toBe("INVITED_CAN_JOIN");
  });

  it("answers 404 for a group that does not exist", async () => {
    const { token } = await account([SETTINGS]);
    expect((await api(token, `${SET}/nobody@fake.test`)).status).toBe(404);
    expect((await patch(token, { name: "x" }, "nobody@fake.test")).status).toBe(404);
  });
});

describe("consumer account", () => {
  it("gets Google's not-authorized 403 on every route, and no data leaks", async () => {
    const { token } = await account([GROUP, MEMBER, SETTINGS], { preset: "consumer" });
    for (const [method, path, body] of [
      ["GET", DIR, undefined],
      ["GET", `${DIR}/${TEAM}`, undefined],
      ["GET", `${DIR}/${TEAM}/members`, undefined],
      ["POST", `${DIR}/${TEAM}/members`, { email: "a@fake.test" }],
      ["DELETE", `${DIR}/${TEAM}/members/dana@fake.test`, undefined],
      ["GET", `${SET}/team@fake.test`, undefined],
      ["PATCH", `${SET}/team@fake.test`, { name: "x" }],
    ] as const) {
      const res = await json<GoogleErrorBody>(send(token, method, path, body), 403);
      expect(res.error, `${method} ${path}`).toMatchObject({ code: 403, message: "Not Authorized to access this resource/api", status: "PERMISSION_DENIED" });
      expect(res.error.errors).toEqual([{ domain: "global", reason: "notAuthorized", message: "Not Authorized to access this resource/api" }]);
    }
  });

  it("is the workspace account that is not affected", async () => {
    const { token } = await account([GROUP]);
    expect((await api(token, DIR)).status).toBe(200);
  });
});

describe("durable store", () => {
  it("keeps an inserted member so that a following read sees it, with small chunks", async () => {
    const store = new DoStore(memoryBackend(), { chunkChars: 64 });
    await store.put("groups:group:do@fake.test:g1", { kind: "admin#directory#group", id: "g1", email: "g1@fake.test", name: "n".repeat(200), directMembersCount: "0", adminCreated: true });
    expect((await callRoute(routes, store, "POST", `${DIR}/g1/members`, { email: "m@fake.test" })).status).toBe(200);
    const list = await json<MemberList>(callRoute(routes, store, "GET", `${DIR}/g1/members`));
    expect(list.members?.map((m) => m.email)).toEqual(["m@fake.test"]);
    expect((await json<Group>(callRoute(routes, store, "GET", `${DIR}/g1`))).directMembersCount).toBe("1");
  });
});

describe("fixtures", () => {
  it("are what the fake serves for a seeded account, replayed in order", async () => {
    const { email, token } = await account([GROUP, MEMBER, MEMBER_RO, SETTINGS]);
    const steps: Array<[ReturnType<typeof parseFixture>, unknown?]> = [
      [parseFixture(groupsList)],
      [parseFixture(groupsGet)],
      [parseFixture(membersList)],
      [parseFixture(membersInsert), { email: "gwen@fake.test", role: "MEMBER" }],
      [parseFixture(settingsGet)],
      [parseFixture(settingsPatch), { whoCanJoin: "ANYONE_CAN_JOIN", allowExternalMembers: "true" }],
    ];
    for (const [fx, body] of steps) {
      expect(await replay(token, email, fx, body), fx.id).toEqual(fx.response.body);
    }
  });
});
