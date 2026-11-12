import { z } from "zod";
import { PENDING_TOKEN_PREFIX, type CallCtx, type FnDef } from "../../contracts";
import { GwsError, isGwsError } from "../../errors";
import { paginate } from "../../google/paginate";

const MAX_ACCOUNTS = 50;
const MAX_CONTAINERS = 500;
const MAX_PAGES = 10;
const READ_SCOPE = "https://www.googleapis.com/auth/tagmanager.readonly";

const Ref = z.string().min(1).max(320).optional();
const NumericId = z.string().regex(/^\d{1,20}$/, "use the numeric id");
/** A container is named by its numeric id or its public id (GTM-XXXX). */
const ContainerRef = z.string().regex(/^(\d{1,20}|GTM-[A-Z0-9]{1,16})$/i, "use the numeric container id or the GTM-XXXX public id");

const isPending = (v: unknown): v is { __gwsPending: string } => typeof v === "object" && v !== null && "__gwsPending" in v;
const accountOf = (account: string | undefined) => (account === undefined ? {} : { account });

const ContainerRow = z.strictObject({
  accountId: z.string(),
  accountName: z.string(),
  containerId: z.string(),
  name: z.string(),
  publicId: z.string().optional(),
  usageContext: z.array(z.string()),
});
type ContainerRow = z.output<typeof ContainerRow>;

const AccountsPage = z.looseObject({
  account: z.array(z.looseObject({ accountId: z.string(), name: z.string().optional() })).optional(),
  nextPageToken: z.string().optional(),
});
const ContainersPage = z.looseObject({
  container: z
    .array(z.looseObject({ containerId: z.string(), name: z.string().optional(), publicId: z.string().optional(), usageContext: z.array(z.string()).optional() }))
    .optional(),
  nextPageToken: z.string().optional(),
});

interface Listed {
  rows: ContainerRow[];
  truncated: boolean;
}

/** Accounts, then each account's containers, flattened. `onlyAccount` limits the walk to one account. */
async function listContainers(ctx: CallCtx, account: string | undefined, onlyAccount?: string): Promise<Listed> {
  const acct = accountOf(account);
  let accounts: Array<{ accountId: string; name: string }>;
  let truncated = false;
  if (onlyAccount === undefined) {
    const walked = await paginate<{ accountId: string; name: string }>(
      async (pageToken) => {
        const page = AccountsPage.safeParse(await ctx.call("tagmanager.accounts.list", { ...(pageToken === undefined ? {} : { pageToken }), ...acct }));
        if (!page.success) throw new GwsError("GWS_RESPONSE_SHAPE", "tagmanager.accounts.list returned an unexpected shape");
        return {
          items: (page.data.account ?? []).map((a) => ({ accountId: a.accountId, name: a.name ?? "" })),
          ...(page.data.nextPageToken === undefined ? {} : { nextPageToken: page.data.nextPageToken }),
        };
      },
      { maxPages: MAX_PAGES, maxItems: MAX_ACCOUNTS },
    );
    accounts = walked.items;
    truncated = walked.truncated;
  } else {
    accounts = [{ accountId: onlyAccount, name: "" }];
  }

  const rows: ContainerRow[] = [];
  for (const a of accounts) {
    const walked = await paginate<ContainerRow>(
      async (pageToken) => {
        const page = ContainersPage.safeParse(
          await ctx.call("tagmanager.accounts.containers.list", { parent: `accounts/${a.accountId}`, ...(pageToken === undefined ? {} : { pageToken }), ...acct }),
        );
        if (!page.success) throw new GwsError("GWS_RESPONSE_SHAPE", "tagmanager.accounts.containers.list returned an unexpected shape");
        return {
          items: (page.data.container ?? []).map((c) => ({
            accountId: a.accountId,
            accountName: a.name,
            containerId: c.containerId,
            name: c.name ?? "",
            ...(c.publicId === undefined ? {} : { publicId: c.publicId }),
            usageContext: c.usageContext ?? [],
          })),
          ...(page.data.nextPageToken === undefined ? {} : { nextPageToken: page.data.nextPageToken }),
        };
      },
      { maxPages: MAX_PAGES, maxItems: MAX_CONTAINERS - rows.length },
    );
    rows.push(...walked.items);
    if (walked.truncated || rows.length >= MAX_CONTAINERS) {
      truncated = true;
      break;
    }
  }
  return { rows, truncated };
}

/** The one container a numeric or public id names; an id found in several accounts needs `accountId`. */
async function findContainer(ctx: CallCtx, containerId: string, accountId: string | undefined, account: string | undefined): Promise<ContainerRow> {
  const { rows } = await listContainers(ctx, account, accountId);
  const wanted = containerId.toUpperCase();
  const hits = rows.filter((r) => r.containerId === containerId || r.publicId?.toUpperCase() === wanted);
  if (hits.length === 0) {
    throw new GwsError("GWS_INVALID_INPUT", "no Tag Manager container with this id is visible to the account; list them with tagmanager.containers", { details: { field: "containerId" } });
  }
  if (hits.length > 1) {
    throw new GwsError("GWS_INVALID_INPUT", "several accounts hold a container with this id; pass accountId", { details: { field: "accountId" } });
  }
  return hits[0] as ContainerRow;
}

// ---------- containers ----------

const ContainersInput = z.strictObject({ account: Ref });
type ContainersInput = z.output<typeof ContainersInput>;

const ContainersOutput = z.strictObject({ containers: z.array(ContainerRow), truncated: z.boolean() });
type ContainersOutput = z.output<typeof ContainersOutput>;

const containersDef: FnDef<ContainersInput, ContainersOutput> = {
  kind: "host",
  name: "tagmanager.containers",
  service: "helpers",
  effect: "read",
  description:
    "Lists every Google Tag Manager (GTM) container the account can see, across its accounts, flattened: account id and name, numeric container id, name, public id (GTM-XXXX) and usage context. Use the ids with tagmanager.workspaceStatus and tagmanager.publish.",
  signature:
    "tagmanager.containers({ account?: string }): Promise<{ containers: { accountId: string, accountName: string, containerId: string, name: string, publicId?: string, usageContext: string[] }[], truncated: boolean }>",
  tsDecl: [
    "type Input = { account?: string };",
    "type Output = {",
    "  containers: { accountId: string; accountName: string; containerId: string; name: string; publicId?: string; usageContext: string[] }[];",
    "  truncated: boolean; // more than 50 accounts or 500 containers",
    "};",
  ].join("\n"),
  example: "await sdk.tagmanager.containers({})",
  tags: ["helpers", "tagmanager", "gtm", "google", "tag", "manager", "containers", "container", "accounts", "list", "read"],
  scopes: [READ_SCOPE],
  input: ContainersInput,
  output: ContainersOutput,
  async run(input, ctx) {
    const { rows, truncated } = await listContainers(ctx, input.account);
    return { containers: rows, truncated };
  },
};

// ---------- workspace status ----------

const StatusInput = z.strictObject({ account: Ref, containerId: ContainerRef, accountId: NumericId.optional(), workspaceId: NumericId.optional() });
type StatusInput = z.output<typeof StatusInput>;

const Change = z.strictObject({ type: z.string(), id: z.string().optional(), name: z.string(), changeStatus: z.string() });
const Conflict = z.strictObject({ type: z.string(), name: z.string() });
const StatusOutput = z.strictObject({
  accountId: z.string(),
  containerId: z.string(),
  containerName: z.string(),
  workspaces: z.array(
    z.strictObject({ workspaceId: z.string(), name: z.string(), pendingChanges: z.array(Change), mergeConflicts: z.array(Conflict) }),
  ),
});
type StatusOutput = z.output<typeof StatusOutput>;

const WorkspacesPage = z.looseObject({
  workspace: z.array(z.looseObject({ workspaceId: z.string(), name: z.string().optional() })).optional(),
  nextPageToken: z.string().optional(),
});
const EntityRef = z.record(z.string(), z.unknown());
const WorkspaceStatus = z.looseObject({
  workspaceChange: z.array(z.looseObject({ changeStatus: z.string().optional() })).optional(),
  mergeConflict: z.array(z.looseObject({ entityInWorkspace: z.looseObject({}).optional() })).optional(),
});

/** An entity wrapper like `{ tag: { name, tagId }, changeStatus }` has one key naming the kind. */
function describeEntity(wrapper: Record<string, unknown>): { type: string; id?: string; name: string } {
  for (const [type, value] of Object.entries(wrapper)) {
    if (type === "changeStatus" || typeof value !== "object" || value === null) continue;
    const entity = value as Record<string, unknown>;
    const idKey = `${type}Id`;
    const id = entity[idKey];
    return { type, ...(typeof id === "string" ? { id } : {}), name: typeof entity.name === "string" ? entity.name : "" };
  }
  return { type: "unknown", name: "" };
}

const statusDef: FnDef<StatusInput, StatusOutput> = {
  kind: "host",
  name: "tagmanager.workspaceStatus",
  service: "helpers",
  effect: "read",
  description:
    "Shows the pending changes and merge conflicts of a Google Tag Manager (GTM) container's workspaces, i.e. what a publish would put live: each changed tag, trigger or variable with its change status (added, updated, deleted). Covers every workspace of the container unless workspaceId is given.",
  signature:
    "tagmanager.workspaceStatus({ containerId: string, accountId?: string, workspaceId?: string, account?: string }): Promise<{ accountId: string, containerId: string, containerName: string, workspaces: { workspaceId: string, name: string, pendingChanges: { type: string, id?: string, name: string, changeStatus: string }[], mergeConflicts: { type: string, name: string }[] }[] }>",
  tsDecl: [
    "type Input = {",
    "  containerId: string; // numeric id or public id (GTM-XXXX), see tagmanager.containers",
    "  accountId?: string; // only when several accounts hold that container id",
    "  workspaceId?: string; // default: every workspace",
    "  account?: string;",
    "};",
    "type Output = {",
    "  accountId: string;",
    "  containerId: string;",
    "  containerName: string;",
    "  workspaces: {",
    "    workspaceId: string;",
    "    name: string;",
    '    pendingChanges: { type: string; id?: string; name: string; changeStatus: string }[]; // type: "tag", "trigger", "variable" ...',
    "    mergeConflicts: { type: string; name: string }[];",
    "  }[];",
    "};",
  ].join("\n"),
  example: 'await sdk.tagmanager.workspaceStatus({ containerId: "GTM-AB12CD" })',
  tags: ["helpers", "tagmanager", "gtm", "google", "tag", "manager", "workspace", "status", "pending", "changes", "conflicts", "unpublished", "read"],
  scopes: [READ_SCOPE],
  input: StatusInput,
  output: StatusOutput,
  async run(input, ctx) {
    const container = await findContainer(ctx, input.containerId, input.accountId, input.account);
    const base = `accounts/${container.accountId}/containers/${container.containerId}`;
    const acct = accountOf(input.account);

    let workspaces: Array<{ workspaceId: string; name: string }>;
    if (input.workspaceId !== undefined) {
      workspaces = [{ workspaceId: input.workspaceId, name: "" }];
    } else {
      const walked = await paginate<{ workspaceId: string; name: string }>(
        async (pageToken) => {
          const page = WorkspacesPage.safeParse(await ctx.call("tagmanager.accounts.containers.workspaces.list", { parent: base, ...(pageToken === undefined ? {} : { pageToken }), ...acct }));
          if (!page.success) throw new GwsError("GWS_RESPONSE_SHAPE", "tagmanager.accounts.containers.workspaces.list returned an unexpected shape");
          return {
            items: (page.data.workspace ?? []).map((w) => ({ workspaceId: w.workspaceId, name: w.name ?? "" })),
            ...(page.data.nextPageToken === undefined ? {} : { nextPageToken: page.data.nextPageToken }),
          };
        },
        { maxPages: MAX_PAGES, maxItems: 100 },
      );
      workspaces = walked.items;
    }

    const out: StatusOutput["workspaces"] = [];
    for (const w of workspaces) {
      const status = WorkspaceStatus.safeParse(await ctx.call("tagmanager.accounts.containers.workspaces.getStatus", { path: `${base}/workspaces/${w.workspaceId}`, ...acct }));
      if (!status.success) throw new GwsError("GWS_RESPONSE_SHAPE", "tagmanager.accounts.containers.workspaces.getStatus returned an unexpected shape");
      out.push({
        workspaceId: w.workspaceId,
        name: w.name,
        pendingChanges: (status.data.workspaceChange ?? []).map((c) => ({ ...describeEntity(EntityRef.parse(c)), changeStatus: c.changeStatus ?? "" })),
        mergeConflicts: (status.data.mergeConflict ?? []).map((c) => {
          const { type, name } = describeEntity(EntityRef.parse(c.entityInWorkspace ?? {}));
          return { type, name };
        }),
      });
    }
    return { accountId: container.accountId, containerId: container.containerId, containerName: container.name, workspaces: out };
  },
};

// ---------- publish ----------

const PublishInput = z.strictObject({
  account: Ref,
  containerId: ContainerRef,
  accountId: NumericId.optional(),
  workspaceId: NumericId,
  name: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
});
type PublishInput = z.output<typeof PublishInput>;

const Described = { containerName: z.string(), publicId: z.string().optional(), workspaceName: z.string() };
const PublishPlanned = z.strictObject({ applied: z.literal(false), steps: z.array(z.string()), ...Described });
const Published = z.strictObject({
  applied: z.literal(true),
  versionId: z.string(),
  ...Described,
  /** The workspace Tag Manager opened on the new version; the old one no longer exists. */
  newWorkspacePath: z.string().optional(),
});
const PublishOutput = z.union([PublishPlanned, Published]);
type PublishOutput = z.output<typeof PublishOutput>;

const VersionResult = z.looseObject({
  containerVersion: z.looseObject({ containerVersionId: z.string().optional(), path: z.string().optional(), fingerprint: z.string().optional() }).optional(),
  newWorkspacePath: z.string().optional(),
  compilerError: z.boolean().optional(),
});
const WorkspaceName = z.looseObject({ name: z.string().optional() });

/** The refusal of the one-run publish where publishing needs the person's approval, with the two runs to do instead. */
function publishNeedsTwoRuns(workspacePath: string, containerPath: string): GwsError {
  return new GwsError(
    "GWS_APPROVAL_REQUIRED",
    `Publishing needs the person's approval, and this helper would publish a version it creates in the same run, which cannot be approved. Nothing was changed. Do it in two runs: ` +
      `1) run sdk.tagmanager.accounts.containers.workspaces.create_version({ path: "${workspacePath}" }) with apply:true and keep containerVersion.containerVersionId from its result; ` +
      `2) dry-run sdk.tagmanager.accounts.containers.versions.publish({ path: "${containerPath}/versions/<that id>" }), give the person the approval link from its result, and after they approve run the same code with apply:true`,
    { details: { reasons: ["publish"], workspacePath } },
  );
}

const publishDef: FnDef<PublishInput, PublishOutput> = {
  kind: "host",
  name: "tagmanager.publish",
  service: "helpers",
  effect: "write",
  description:
    "Publishes a Google Tag Manager (GTM) workspace live: saves the workspace as a new container version, then publishes that version. Destructive (publish): it changes what the website serves. A dry-run plans both steps and names the container and workspace; apply:true runs them. Saving the version replaces the workspace with a new one, returned as newWorkspacePath. Where publishing needs the person's approval (the remote server's default), it cannot do both in one run and refuses with GWS_APPROVAL_REQUIRED naming the two runs instead: tagmanager.accounts.containers.workspaces.create_version with apply:true, then tagmanager.accounts.containers.versions.publish on the returned version, approved by the person.",
  signature:
    "tagmanager.publish({ containerId: string, workspaceId: string, name?: string, notes?: string, accountId?: string, account?: string }): Promise<{ applied: false, steps: string[], containerName: string, publicId?: string, workspaceName: string } | { applied: true, versionId: string, containerName: string, publicId?: string, workspaceName: string, newWorkspacePath?: string }>",
  tsDecl: [
    "type Input = {",
    "  containerId: string; // numeric id or public id (GTM-XXXX), see tagmanager.containers",
    "  workspaceId: string;",
    "  name?: string; // the version's name",
    "  notes?: string; // the version's notes",
    "  accountId?: string; // only when several accounts hold that container id",
    "  account?: string;",
    "};",
    "type Output = { applied: false; steps: string[]; containerName: string; publicId?: string; workspaceName: string } // dry-run: re-run with apply:true",
    "  | { applied: true; versionId: string; containerName: string; publicId?: string; workspaceName: string; newWorkspacePath?: string };",
  ].join("\n"),
  example: 'await sdk.tagmanager.publish({ containerId: "GTM-AB12CD", workspaceId: "1", name: "Launch", notes: "Add signup tag" })',
  tags: ["helpers", "tagmanager", "gtm", "google", "tag", "manager", "publish", "version", "workspace", "container", "live", "release", "write"],
  scopes: [
    "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
    "https://www.googleapis.com/auth/tagmanager.publish",
  ],
  input: PublishInput,
  output: PublishOutput,
  async run(input, ctx) {
    const acct = accountOf(input.account);
    const container = await findContainer(ctx, input.containerId, input.accountId, input.account);
    const containerPath = `accounts/${container.accountId}/containers/${container.containerId}`;
    const workspacePath = `${containerPath}/workspaces/${input.workspaceId}`;
    const workspace = WorkspaceName.safeParse(await ctx.call("tagmanager.accounts.containers.workspaces.get", { path: workspacePath, ...acct }));
    if (!workspace.success) throw new GwsError("GWS_RESPONSE_SHAPE", "tagmanager.accounts.containers.workspaces.get returned an unexpected shape");
    const described = {
      containerName: container.name,
      ...(container.publicId === undefined ? {} : { publicId: container.publicId }),
      workspaceName: workspace.data.name ?? "",
    };
    // The publish would use the version this run creates, so it can never be approved as planned: before any write,
    // say how to do it in two runs.
    if (ctx.config.GWS_HUMAN_APPROVAL.includes("publish")) throw publishNeedsTwoRuns(workspacePath, containerPath);

    const created = await ctx.call("tagmanager.accounts.containers.workspaces.create_version", {
      path: workspacePath,
      requestBody: { ...(input.name === undefined ? {} : { name: input.name }), ...(input.notes === undefined ? {} : { notes: input.notes }) },
      ...acct,
    });
    if (isPending(created)) {
      // Dry-run: the publish waits on the version the unexecuted save would create.
      const published = await ctx.call("tagmanager.accounts.containers.versions.publish", {
        path: `${containerPath}/versions/${PENDING_TOKEN_PREFIX}${created.__gwsPending}.containerVersion.containerVersionId`,
        ...acct,
      });
      if (!isPending(published)) throw new GwsError("GWS_INTERNAL", "the publish ran before the version it waits on");
      // The raw steps show only ids; this one names what goes live.
      const summary = ctx.planStep({
        fn: "tagmanager.publish",
        account: (await ctx.resolveAllowed(input.account)).email,
        effect: "write",
        destructive: true,
        reason: "publish",
        note: `Publishes workspace "${described.workspaceName}" (${input.workspaceId}) of container "${described.containerName}"${described.publicId === undefined ? "" : ` (${described.publicId})`} live: saves it as a new version, then publishes that version.`,
      });
      return { applied: false, steps: [created.__gwsPending, published.__gwsPending, summary], ...described };
    }

    const version = VersionResult.safeParse(created);
    const versionId = version.success ? version.data.containerVersion?.containerVersionId : undefined;
    if (!version.success || versionId === undefined) throw new GwsError("GWS_RESPONSE_SHAPE", "create_version returned no version id");
    const newWorkspacePath = version.data.newWorkspacePath;
    if (version.data.compilerError === true) {
      throw new GwsError("GWS_UPSTREAM_ERROR", "Tag Manager saved the version but it has a compiler error, so it was not published", {
        details: { versionId, ...(newWorkspacePath === undefined ? {} : { newWorkspacePath }) },
      });
    }

    try {
      await ctx.call("tagmanager.accounts.containers.versions.publish", {
        path: version.data.containerVersion?.path ?? `${containerPath}/versions/${versionId}`,
        ...(version.data.containerVersion?.fingerprint === undefined ? {} : { fingerprint: version.data.containerVersion.fingerprint }),
        ...acct,
      });
    } catch (e) {
      // The save already replaced the workspace: say where the work is, so a retry publishes that version.
      if (!isGwsError(e)) throw e;
      throw new GwsError(e.code, `${e.message} (version ${versionId} was saved and the workspace is now ${newWorkspacePath ?? "a new one"}; publish that version)`, {
        details: { ...e.details, versionId, ...(newWorkspacePath === undefined ? {} : { newWorkspacePath }) },
        ...(e.fn === undefined ? {} : { fn: e.fn }),
        ...(e.account === undefined ? {} : { account: e.account }),
      });
    }
    return { applied: true, versionId, ...described, ...(newWorkspacePath === undefined ? {} : { newWorkspacePath }) };
  },
};

// The registry holds FnDef<unknown>; these definitions are typed with their own input and output.
export const tagmanagerContainers = containersDef as FnDef;
export const tagmanagerWorkspaceStatus = statusDef as FnDef;
export const tagmanagerPublish = publishDef as FnDef;
