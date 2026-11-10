import type { FakeStore, JsonValue } from "../store";
import * as calendar from "./calendar";
import * as docs from "./docs";
import * as drive from "./drive";
import * as forms from "./forms";
import * as gmail from "./gmail";
import * as sheets from "./sheets";
import * as slides from "./slides";
import * as tasks from "./tasks";

/** What a route handler receives. Access (token + route scopes) is already checked. */
export interface FakeContext {
  req: Request;
  url: URL;
  /** Host-prefixed path, e.g. "/gmail.googleapis.com/gmail/v1/users/me/messages". */
  path: string;
  match: RegExpExecArray;
  store: FakeStore;
  /** Owner of the bearer token. */
  email: string;
  /** Scopes granted to the bearer token. */
  scopes: string[];
  /** Current time in ms: the clock seeded for this account, else wall time. */
  now(): number;
}

export interface FakeRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Matched against the host-prefixed path. */
  pattern: RegExp;
  /** Any one of these must be granted to the bearer token (Discovery `scopes` of the method). */
  scopes: string[];
  handle(ctx: FakeContext): Response | Promise<Response>;
}

/** Seed data a service contributes under a preset name. `{email}` in keys and string values is replaced. */
export interface SeedResourceTemplate {
  key: string;
  value: JsonValue;
}
export type SeedPresets = Record<string, SeedResourceTemplate[]>;

const services = [gmail, drive, calendar, sheets, docs, forms, tasks, slides];

export const routes: FakeRoute[] = services.flatMap((s) => s.routes);

export const seedPresets: SeedPresets = {};
for (const s of services) {
  for (const [name, items] of Object.entries(s.presets)) {
    seedPresets[name] = [...(seedPresets[name] ?? []), ...items];
  }
}
