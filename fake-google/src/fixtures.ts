import { z } from "zod";
import defaultSeed from "../fixtures/seed/default.json";
import { EMAIL_RE, RESERVED_NAMESPACES, parseKey, type JsonValue } from "./store";

const Json = z.json() as z.ZodType<JsonValue>;

export const EmailSchema = z.string().max(254).regex(EMAIL_RE, "invalid email");

/** A seedable resource key: `<svc>:<kind>:<email>:<id>`, outside the fake's own namespaces. */
export const ResourceKeySchema = z
  .string()
  .max(512)
  .refine((k) => {
    const parts = parseKey(k);
    return parts !== undefined && !RESERVED_NAMESPACES.has(parts.svc) && EMAIL_RE.test(parts.email);
  }, "key must be <svc>:<kind>:<email>:<id> outside reserved namespaces");

/** Reserved TLDs (RFC 2606/6761): a seeded fake account can never share an address with a real Google account. */
const RESERVED_TLD_RE = /\.(test|example|invalid)$/i;

export const SeedEmailSchema = EmailSchema.refine(
  (e) => RESERVED_TLD_RE.test(e),
  "seed emails must use a reserved TLD (.test, .example or .invalid)",
);

export const SeedAccountSchema = z.strictObject({
  email: SeedEmailSchema,
  sub: z.string().min(1).max(255),
  /** Name of a resource preset contributed by the route modules (`seedPresets`). */
  preset: z.string().min(1).max(64).optional(),
});

export const SeedRequestSchema = z.strictObject({
  accounts: z.array(SeedAccountSchema).max(100).default([]),
  resources: z.array(z.strictObject({ key: ResourceKeySchema, value: Json })).max(1000).optional(),
  /** Fixes the fake clock (ms since epoch) for every account in this request. */
  now: z.number().int().nonnegative().optional(),
});
export type SeedRequest = z.input<typeof SeedRequestSchema>;
export type ParsedSeedRequest = z.output<typeof SeedRequestSchema>;

const Query = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

/** Request/response pair, synthesized from Discovery schemas before the gate or recorded after it. */
export const FixtureSchema = z.strictObject({
  id: z.string().min(1),
  source: z.enum(["synthesized", "recorded"]),
  provenance: z.string().min(1),
  request: z.strictObject({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().startsWith("/"),
    query: Query.optional(),
  }),
  response: z.strictObject({
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()).optional(),
    body: Json,
  }),
});
export type Fixture = z.output<typeof FixtureSchema>;

export function parseFixture(value: unknown): Fixture {
  return FixtureSchema.parse(value);
}

const SEED_FIXTURES = { default: defaultSeed } as const;
export type SeedFixtureName = keyof typeof SEED_FIXTURES;

/** A seed file from fixtures/seed, validated with the same schema as `POST /__fake/seed`. */
export function loadSeedFixture(name: SeedFixtureName): ParsedSeedRequest {
  return SeedRequestSchema.parse(SEED_FIXTURES[name]);
}
