import { env } from "cloudflare:workers";
import { loadConfig, type Config } from "../../src/config";
import type { AuthProps } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

export const G = "https://www.googleapis.com/auth/";
const store = openStore(env);
const baseConfig = loadConfig(env);

export interface Client {
  email: string;
  auth: AuthProps;
}

/** A user with one account holding `scopes`, seeded at the fake with the default preset and granted to a new client. */
export async function connect(label: string, scopes: readonly string[], opts: { now?: number } = {}): Promise<Client> {
  const email = uniqueEmail(label);
  const seeded = await seedUserWithAccount(env, { email, scopes, isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }], ...(opts.now === undefined ? {} : { now: opts.now }) });
  const auth: AuthProps = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
  return { email, auth };
}

/** Another account of the same user, seeded with the default preset and granted to the same client. */
export async function connectMore(client: Client, label: string, scopes: readonly string[], opts: { now?: number } = {}): Promise<string> {
  const email = uniqueEmail(label);
  const seeded = await seedUserWithAccount(env, { email, scopes, userId: client.auth.userId });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }], ...(opts.now === undefined ? {} : { now: opts.now }) });
  await store.grants.add(client.auth.userId, client.auth.clientId, seeded.account.id);
  return email;
}

export function session(auth: AuthProps, apply: boolean, config: Partial<Config> = {}) {
  const executeId = `x-${crypto.randomUUID()}`;
  return { s: createCallSession({ ports: workersPorts(env), auth, apply, executeId, config: { ...baseConfig, ...config } }), executeId };
}

export function valueOf(r: DispatchResult): Record<string, unknown> {
  if (!("ok" in r)) throw new Error(`expected a value result, got ${JSON.stringify(r)}`);
  return r.value as Record<string, unknown>;
}

export function errorCodeOf(r: DispatchResult): string | undefined {
  return "__gwsError" in r ? r.__gwsError.code : undefined;
}

export async function auditRows(executeId: string): Promise<Array<{ fn: string; applied: number; status: string }>> {
  const { results } = await env.DB.prepare("SELECT fn, applied, status FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
  return results.map((r) => ({ fn: String(r.fn), applied: Number(r.applied), status: String(r.status) }));
}
