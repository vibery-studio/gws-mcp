import { GWS_ERROR_CODES, type GwsErrorCode } from "../errors";
import { GOOGLE_SERVICES, SCOPE_PRESETS, type GoogleService, type ScopePreset } from "../config";

/**
 * Every shared user-facing string of the web pages: the plain-language glossary, navigation, statuses,
 * actions, trust statements, empty states, Google service descriptions and error wording. Page-specific
 * strings live in their page module; anything two pages say the same way lives here. No string here may
 * use a technical term (the plain-language test checks every one); the one exception is the connection
 * help, which pages render only inside the marked help block.
 *
 * Values are plain text. Pages escape them on render like any other value.
 */

/**
 * The canonical glossary: the user-facing term for each technical concept, with its one-line explanation.
 * Keys name the concept for developers; only `term` and `explain` are ever shown. Two concepts have no
 * entry: access tokens have no UI term at all, and an activity history page does not exist yet.
 */
export const GLOSSARY = {
  signInWithGoogle: { term: "Continue with Google", explain: "Google will ask you to sign in and review access." },
  googleServices: { term: "Google services", explain: "Choose which parts of your Google account to connect." },
  aiApp: { term: "AI app", explain: "An AI app, such as Claude, that asks to use your Google accounts." },
  allowAccess: { term: "Allow access", explain: "Choose which Google accounts this AI app can use." },
  accountName: { term: "Account name", explain: "Give this account a name you will recognize, such as Work." },
  defaultAccount: {
    term: "Default account",
    explain: "The account your AI uses when you do not name one, provided the AI app is allowed to use it.",
  },
  connected: { term: "Connected", explain: "This account is ready for use through gws-mcp." },
  needsReconnecting: { term: "Needs reconnecting", explain: "Google needs you to review access again before this account can be used." },
  reconnect: { term: "Reconnect", explain: "Return to Google to review and approve access." },
  removeAiApp: { term: "Remove AI app", explain: "Stop this AI app from using your accounts through gws-mcp." },
  disconnectAccount: { term: "Disconnect account", explain: "Disconnect this Google account and remove its Google-side access." },
  previewChanges: { term: "Preview changes first", explain: "Your AI can show proposed changes before applying them when you ask." },
  destructiveAction: { term: "Action that can delete or remove information", explain: "These actions are flagged for extra attention." },
} as const satisfies Record<string, { term: string; explain: string }>;

/** Shared strings, grouped by where they appear. */
export const COPY = {
  product: "gws-mcp",
  shell: {
    navLabel: "Main",
    breadcrumbLabel: "Breadcrumb",
    skipToContent: "Skip to content",
    signedInAs: "Signed in as",
    signOut: "Sign out",
  },
  nav: { home: "Home", accounts: "Google accounts", apps: "AI apps" },
  /** Account status chips, by stored status. `active` and `reconnect` are glossary terms. */
  status: { active: GLOSSARY.connected.term, reconnect: GLOSSARY.needsReconnecting.term, disconnected: "Disconnected" },
  chips: { default: "Default", approved: "Approved" },
  actions: {
    continueWithGoogle: GLOSSARY.signInWithGoogle.term,
    continueToGoogle: "Continue to Google",
    addGoogleAccount: "Add Google account",
    addGoogleServices: "Add Google services",
    manageAccount: "Manage account",
    manageAccess: "Manage access",
    manageAiApps: "Manage AI apps",
    viewAccounts: "View accounts",
    reconnect: GLOSSARY.reconnect.term,
    tryAgain: "Try again",
    makeDefault: "Make default",
    saveName: "Save name",
    saveChanges: "Save changes",
    cancel: "Cancel",
    backToAccount: "Back to account",
    disconnectAccount: GLOSSARY.disconnectAccount.term,
    removeAiApp: GLOSSARY.removeAiApp.term,
    allowSelected: "Allow selected accounts",
    dontAllow: "Don't allow",
  },
  trust: {
    /**
     * The write guard as the backend behaves: a write is only planned until the AI app runs it again with an
     * explicit apply, and destructive actions are flagged. Whether the user is asked before that second step
     * depends on the AI app, so the sentence does not promise it.
     */
    writeGuard:
      "Your AI app previews changes first and applies them only in a second, explicit step. Actions that can delete or remove information are flagged.",
    /** An AI app's name is whatever the app registered; it is never proof of who made it. */
    appNameNotVerified: "This name comes from the AI app itself. gws-mcp can't confirm who made it.",
    googleDataNotDeleted: "Your emails and files in Google will not be deleted.",
    defaultIsNotAccess: "Changing the default account does not change which accounts an AI app can use.",
    connectedVsAllowed: "A Google account is connected to gws-mcp. An AI app is allowed to use the accounts you choose.",
    servicesFollowAccount: "An AI app allowed to use an account can use the Google services connected for that account.",
    servicesAddOnly: "You can add Google services to an account. To remove them, disconnect the account.",
    newAccountNotShared: (name: string) => `Your existing AI apps can't use ${name} yet.`,
    appStaysApprovedWithoutAccounts: (app: string) =>
      `${app} stays approved but can't use any of your Google accounts. To remove it completely, use Remove AI app.`,
  },
  empty: {
    noAccounts: "No Google accounts are connected for AI use.",
    firstAccount: "Get your first Google account ready. Choose which Google services you want your AI apps to use.",
    noApps: "No AI apps have been approved yet. When an AI app connects, you'll review its request here and choose which Google accounts it can use.",
    noAppsForAccount: "No AI apps can use this account yet.",
    allServicesConnected: "All available Google services are connected.",
  },
  /** Fallback banner text for a flash a page has no wording of its own for. */
  flash: { saved: "Your changes were saved." },
} as const;

/**
 * The static help on connecting an AI app. It names the server's connector address, so it may only be
 * rendered inside the marked help block (`helpBlock` in ui.ts).
 */
export function connectAppHelp(connectorUrl: string): { title: string; steps: readonly string[] } {
  return {
    title: "How to connect an AI app",
    steps: [
      `In your AI app, add ${connectorUrl} as a connector. In Claude, add it as a custom connector.`,
      "Your AI app sends you here to choose which Google accounts it can use.",
    ],
  };
}

/** Display names of the Google services. */
export const SERVICE_NAMES: Readonly<Record<GoogleService, string>> = {
  gmail: "Gmail",
  drive: "Drive",
  calendar: "Calendar",
  sheets: "Sheets",
  docs: "Docs",
  forms: "Forms",
  tasks: "Tasks",
  slides: "Slides",
  searchconsole: "Search Console",
  analytics: "Analytics",
  analyticsadmin: "Analytics (edit)",
  ads: "Google Ads",
  groups: "Google Groups",
  tagmanager: "Tag Manager",
  tagmanageredit: "Tag Manager (edit)",
  tagmanagerpublish: "Tag Manager (publish)",
  tagmanageradmin: "Tag Manager (admin)",
};

interface ServiceCopy {
  /** The scopes this sentence was written for. A test fails when the requested scopes change without it. */
  readonly writtenFor: readonly string[];
  readonly text: string;
}

const G = "https://www.googleapis.com/auth/";
const FULL_CONTROL = (what: string) => `See, create, change and delete ${what}.`;

/** Descriptions that are the same in both presets, because both ask the same scopes. */
const ANALYTICS: ServiceCopy = { writtenFor: [`${G}analytics.readonly`], text: "See your Analytics reports and settings." };
const ANALYTICS_EDIT: ServiceCopy = { writtenFor: [`${G}analytics.edit`], text: "See, change and delete your Analytics accounts, properties and settings." };
const ADS: ServiceCopy = { writtenFor: [`${G}adwords`], text: "See and change your Google Ads accounts, campaigns, budgets and bids, which can spend money." };
const TAG_MANAGER: ServiceCopy = { writtenFor: [`${G}tagmanager.readonly`], text: "See your Tag Manager accounts, containers, tags, triggers and variables." };
const TAG_MANAGER_EDIT: ServiceCopy = {
  writtenFor: [`${G}tagmanager.edit.containers`],
  text: "Create and change Tag Manager containers, and create, change and delete tags, triggers and variables.",
};
const TAG_MANAGER_PUBLISH: ServiceCopy = {
  writtenFor: [`${G}tagmanager.edit.containerversions`, `${G}tagmanager.publish`],
  text: "Save, change and delete Tag Manager container versions, and publish them to your live website.",
};
const TAG_MANAGER_ADMIN: ServiceCopy = {
  writtenFor: [`${G}tagmanager.manage.accounts`, `${G}tagmanager.manage.users`, `${G}tagmanager.delete.containers`],
  text: "Change your Tag Manager account settings and who can use them, and delete containers and workspaces.",
};

/**
 * One plain line per service and scope preset, matching everything the connect flow requests for it
 * (`SERVICE_SCOPES`). Most requested access can change or delete data, so no line may suggest read-only use.
 */
const SERVICE_COPY: Readonly<Record<ScopePreset, Readonly<Record<GoogleService, ServiceCopy>>>> = {
  narrow: {
    gmail: { writtenFor: [`${G}gmail.readonly`, `${G}gmail.send`], text: "Read your email and send email for you." },
    drive: { writtenFor: [`${G}drive.file`], text: "See, create, change and delete the Drive files you use with gws-mcp." },
    calendar: {
      writtenFor: [`${G}calendar.events`, `${G}calendar.calendarlist.readonly`],
      text: "See your list of calendars, and see, create, change and delete events.",
    },
    sheets: { writtenFor: [`${G}spreadsheets`], text: FULL_CONTROL("your spreadsheets") },
    docs: { writtenFor: [`${G}documents`], text: FULL_CONTROL("your documents") },
    forms: {
      writtenFor: [`${G}forms.body`, `${G}forms.responses.readonly`],
      text: "See, create, change and delete your forms, and read their responses.",
    },
    tasks: { writtenFor: [`${G}tasks`], text: FULL_CONTROL("your tasks") },
    slides: { writtenFor: [`${G}presentations`], text: FULL_CONTROL("your presentations") },
    searchconsole: { writtenFor: [`${G}webmasters.readonly`], text: "See your websites in Search Console and how they appear in Google Search." },
    analytics: ANALYTICS,
    analyticsadmin: ANALYTICS_EDIT,
    ads: ADS,
    groups: {
      writtenFor: [`${G}admin.directory.group.readonly`, `${G}admin.directory.group.member.readonly`, `${G}apps.groups.settings`],
      text: "For Workspace admins: see your organization's Google Groups and members, and change group settings.",
    },
    tagmanager: TAG_MANAGER,
    tagmanageredit: TAG_MANAGER_EDIT,
    tagmanagerpublish: TAG_MANAGER_PUBLISH,
    tagmanageradmin: TAG_MANAGER_ADMIN,
  },
  full: {
    gmail: { writtenFor: ["https://mail.google.com/"], text: "Read, send, organize and permanently delete your email." },
    drive: { writtenFor: [`${G}drive`], text: FULL_CONTROL("all your Drive files") },
    calendar: { writtenFor: [`${G}calendar`], text: FULL_CONTROL("your calendars and events") },
    sheets: { writtenFor: [`${G}spreadsheets`], text: FULL_CONTROL("your spreadsheets") },
    docs: { writtenFor: [`${G}documents`], text: FULL_CONTROL("your documents") },
    forms: {
      writtenFor: [`${G}forms.body`, `${G}forms.responses.readonly`],
      text: "See, create, change and delete your forms, and read their responses.",
    },
    tasks: { writtenFor: [`${G}tasks`], text: FULL_CONTROL("your tasks") },
    slides: { writtenFor: [`${G}presentations`], text: FULL_CONTROL("your presentations") },
    searchconsole: { writtenFor: [`${G}webmasters`], text: "Add and remove your sites and sitemaps in Search Console, and see how they appear in Google Search." },
    analytics: ANALYTICS,
    analyticsadmin: ANALYTICS_EDIT,
    ads: ADS,
    groups: {
      writtenFor: [`${G}admin.directory.group`, `${G}admin.directory.group.member`, `${G}apps.groups.settings`],
      text: "For Workspace admins: see, create, change and delete your organization's groups, members and settings.",
    },
    tagmanager: TAG_MANAGER,
    tagmanageredit: TAG_MANAGER_EDIT,
    tagmanagerpublish: TAG_MANAGER_PUBLISH,
    tagmanageradmin: TAG_MANAGER_ADMIN,
  },
};

/** The plain description of what connecting `service` allows under `preset`. */
export function serviceDescription(preset: ScopePreset, service: GoogleService): string {
  return SERVICE_COPY[preset][service].text;
}

/** The scopes a service's description was written for (for the drift test). */
export function serviceDescriptionBasis(preset: ScopePreset, service: GoogleService): readonly string[] {
  return SERVICE_COPY[preset][service].writtenFor;
}

/** Every preset and service pair, for tests and pages that list them all. */
export const SERVICE_COPY_KEYS: ReadonlyArray<readonly [ScopePreset, GoogleService]> = SCOPE_PRESETS.flatMap((p) =>
  GOOGLE_SERVICES.map((s) => [p, s] as const),
);

/** Google OAuth error names that can reach a page, besides the server's own `GWS_*` codes. */
export const GOOGLE_ERROR_NAMES = ["invalid_grant", "insufficient_scope"] as const;

const SOMETHING_WENT_WRONG = "Something went wrong. Try again in a moment.";

/**
 * A backend error code as a plain action for the user. `account` is the account's display name when the
 * page knows it. Unknown codes get the generic line, never the code itself.
 */
export function plainError(code: string, account?: string): string {
  const it = account ?? "this account";
  const It = account ?? "This account";
  switch (code as GwsErrorCode | (typeof GOOGLE_ERROR_NAMES)[number]) {
    case "invalid_grant":
    case "GWS_RECONNECT_REQUIRED":
      return `Google needs you to reconnect ${it}. Open Google accounts and choose Reconnect.`;
    case "insufficient_scope":
    case "GWS_SCOPE_MISSING":
      return `${It} doesn't have the Google service this needs yet. Add it from the account's Google services.`;
    case "GWS_ACCOUNT_DENIED":
      return "This AI app isn't allowed to use that Google account. You can allow it from AI apps.";
    case "GWS_ACCOUNT_UNKNOWN":
      return "That Google account isn't connected. Add it from Google accounts.";
    case "GWS_NO_DEFAULT_ACCOUNT":
      return "No default account is set. Choose one from Google accounts.";
    case "GWS_ADMIN_REQUIRED":
      return "Google Groups works only with a Google Workspace admin account. Personal Gmail accounts and Workspace users who aren't admins can't use it.";
    case "GWS_ACCOUNT_TAKEN":
      return "This Google account is already connected to another gws-mcp user.";
    case "GWS_CONFIRMATION_REQUIRED":
      return "This change needs your confirmation. Open the link your AI app gave you.";
    case "GWS_APPROVAL_REQUIRED":
      return "This needs your approval first. Open the approval link your AI app gave you.";
    case "GWS_INVALID_INPUT":
      return "Some details weren't valid. Check them and try again.";
    case "GWS_RATE_LIMITED":
      return "Too many requests right now. Wait a minute and try again.";
    case "GWS_UPSTREAM_ERROR":
      return "Google couldn't complete this right now. Try again in a moment.";
    case "GWS_UNKNOWN_METHOD":
    case "GWS_RESPONSE_SHAPE":
    case "GWS_CALL_BUDGET_EXCEEDED":
    case "GWS_RESPONSE_TOO_LARGE":
    case "GWS_EXECUTION_TIMEOUT":
    case "GWS_EXECUTION_ERROR":
    case "GWS_INTERNAL":
      return SOMETHING_WENT_WRONG;
    default:
      return SOMETHING_WENT_WRONG;
  }
}

/** Every code `plainError` knows by name (for its tests). */
export const PLAIN_ERROR_CODES: readonly string[] = [...GWS_ERROR_CODES, ...GOOGLE_ERROR_NAMES];
