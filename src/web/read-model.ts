import { displayClientName, listClients } from "../auth/clients";
import { GOOGLE_SERVICES, grantedServices, loadConfig, type GoogleService, type ScopePreset } from "../config";
import { openStore, type Account, type AccountStatus } from "../store/db";

/**
 * What the signed-in pages render, read for one user: their Google accounts and their approved AI apps,
 * joined both ways through the allowlist ("Allowed for: <apps>" on an account, the allowed accounts on an
 * app). Read only, from the existing tables, and always scoped to the given user. An allowlist row of an app
 * with no recorded approval (possible only in a consent racing a removal) is not an approved app and is
 * left out, since such a row is unusable.
 */

export interface AppRef {
  id: string;
  /** Self-asserted by the app, passed through `displayClientName` when approved. Escape it, and never present it as verified. */
  name: string;
}

export interface AccountView {
  id: string;
  email: string;
  /**
   * The account name, cleaned for display: without control, bidi or zero-width characters (which can reorder
   * text or make two names look alike), and absent when nothing else is left. Escape it wherever it is rendered.
   */
  alias?: string;
  /** What the pages call the account: its cleaned account name when set, else its email. */
  name: string;
  isDefault: boolean;
  /** The account that created the user and signs in (it may sign in even when disconnected). */
  isPrimary: boolean;
  status: AccountStatus;
  /** Services whose every requested scope the account holds, in display order. */
  services: GoogleService[];
  /** Services not connected yet, in display order. */
  missingServices: GoogleService[];
  /** Approved AI apps allowed to use this account, by name. */
  allowedFor: AppRef[];
}

export interface AppView extends AppRef {
  /** Epoch seconds of the latest approval. */
  approvedAt: number;
  /** Ids of this user's accounts the app may use (may include disconnected accounts whose rows are kept). */
  allowedAccountIds: string[];
}

export interface ReadModel {
  /** The email the user signs in with (the primary account's), for the page header. */
  signedInEmail: string;
  preset: ScopePreset;
  accounts: AccountView[];
  apps: AppView[];
  /** The user's account `id`, or undefined (unknown or another user's). */
  account(id: string): AccountView | undefined;
  /** The user's approved app `id`, or undefined. */
  app(id: string): AppView | undefined;
  /** Approved apps allowed to use account `id`. */
  allowedFor(accountId: string): AppRef[];
  /** The user's accounts app `id` may use. */
  allowedAccounts(appId: string): AccountView[];
}

const byName = (a: AppRef, b: AppRef) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * A stored account name made safe to display. The store accepts format characters, and an AI app or the
 * older rename form can write them, so they are stripped the same way as AI app names (the store's 64
 * character cap keeps the name under the display cap). Undefined when nothing visible is left.
 */
function displayAlias(alias: string | undefined): string | undefined {
  if (alias === undefined) return undefined;
  const shown = displayClientName(alias, "");
  return shown === "" ? undefined : shown;
}

function accountView(a: Account, preset: ScopePreset, allowedFor: AppRef[]): AccountView {
  const granted = grantedServices(preset, a.scopes);
  const alias = displayAlias(a.alias);
  return {
    id: a.id,
    email: a.email,
    ...(alias !== undefined ? { alias } : {}),
    name: alias ?? a.email,
    isDefault: a.isDefault,
    isPrimary: a.userId === `u_${a.sub}`,
    status: a.status,
    services: GOOGLE_SERVICES.filter((s) => granted[s]),
    missingServices: GOOGLE_SERVICES.filter((s) => !granted[s]),
    allowedFor,
  };
}

/** Everything the signed-in pages show for `userId`. */
export async function loadReadModel(env: Env, userId: string): Promise<ReadModel> {
  const store = openStore(env);
  const preset = loadConfig(env).GOOGLE_SCOPE_PRESET;
  const [accounts, clients, user] = await Promise.all([store.accounts.listForUser(userId), listClients(env, userId), store.users.findById(userId)]);

  const apps: AppView[] = clients
    .map((c) => ({ id: c.clientId, name: c.clientName, approvedAt: c.approvedAt, allowedAccountIds: [...c.accountIds] }))
    .sort(byName);
  const appsByAccount = new Map<string, AppRef[]>();
  for (const app of apps) {
    for (const accountId of app.allowedAccountIds) {
      const list = appsByAccount.get(accountId) ?? [];
      list.push({ id: app.id, name: app.name });
      appsByAccount.set(accountId, list);
    }
  }
  const views = accounts.map((a) => accountView(a, preset, appsByAccount.get(a.id) ?? []));
  const accountById = new Map(views.map((a) => [a.id, a]));
  const appById = new Map(apps.map((a) => [a.id, a]));
  const primary = views.find((a) => a.isPrimary);

  return {
    signedInEmail: primary?.email ?? user?.primaryEmail ?? "",
    preset,
    accounts: views,
    apps,
    account: (id) => accountById.get(id),
    app: (id) => appById.get(id),
    allowedFor: (accountId) => accountById.get(accountId)?.allowedFor ?? [],
    allowedAccounts: (appId) =>
      (appById.get(appId)?.allowedAccountIds ?? []).map((id) => accountById.get(id)).filter((a): a is AccountView => a !== undefined),
  };
}
