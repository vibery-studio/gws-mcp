/**
 * Words of the "Who can use this" area (the access list), kept apart from the shared copy. Plain language only: the
 * pages that show them pass the no-technical-words check.
 */

/** The admin-only page that manages the access list. */
export const ACCESS_PATH = "/access";

export const ACCESS_COPY = {
  nav: "Who can use this",
  title: "Who can use this",
  lede: "Only the people on this list can sign in here and let their AI apps use it. Add one email address, or a whole domain such as @example.com to let in everyone with an email there.",
  adminsNote: "Admins can also change this list. The last admin can't be removed or made a regular user.",
  moreAccounts: "People on the list can connect any of their own Google accounts.",
  listHeading: "On the list",
  empty: "Nobody is on the list yet.",
  roles: { admin: "Admin", user: "Can use" },
  kinds: { email: "Email", domain: "Everyone at this domain" },
  addHeading: "Add someone",
  patternLabel: "Email address or domain",
  patternHint: "For example ann@example.com, or @example.com for everyone with an email there.",
  roleLabel: "What they can do",
  roleOptions: { user: "Use it", admin: "Use it and change this list" },
  noteLabel: "Note (optional)",
  noteHint: "Only admins see this.",
  add: "Add",
  makeAdmin: "Make admin",
  makeUser: "Make regular user",
  remove: "Remove",
  removeHint: "Removing someone signs them out within a minute, and their AI apps lose access right away.",
  saved: "Saved. The list is updated.",
  removed: "Removed. They can no longer sign in, and their AI apps no longer have access.",
  removedPartly: "Removed, and they can no longer sign in. Part of the cleanup of their AI app connections didn't finish.",
  lastAdmin: "The last admin can't be removed or made a regular user. Add another admin first.",
  badPattern: "Enter an email address such as ann@example.com, or a domain such as @example.com.",
  conflict: "Someone changed this at the same time. Check the list and try again.",
} as const;
