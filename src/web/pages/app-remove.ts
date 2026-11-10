import { html } from "hono/html";
import type { AppContext } from "../../auth/session";
import { COPY } from "../copy";
import { boundedId, genericFlash, notFoundPage, pageContext, sendPage, signedIn } from "../http";
import type { AppView, ReadModel } from "../read-model";
import { confirmLayout, renderPage, type FlashMessage, type ShellUser } from "../ui";

/**
 * GET /apps/:id/remove: the confirmation before removing an AI app. Its form posts to the existing
 * POST /connections/client-revoke (fields `csrf`, `client`), which redirects to /apps with an `app-removed` flash.
 * Removing an app never touches a Google account.
 */

export interface AppRemovePageInput {
  user: ShellUser;
  model: ReadModel;
  app: AppView;
  flash: FlashMessage | null;
}

export function renderAppRemovePage(p: AppRemovePageInput): Promise<string> {
  const { app } = p;
  return renderPage({
    title: `Remove ${app.name}?`,
    user: p.user,
    current: "apps",
    crumbs: [{ href: "/apps", label: COPY.nav.apps }, { href: `/apps/${encodeURIComponent(app.id)}`, label: app.name }, { label: COPY.actions.removeAiApp }],
    flash: p.flash,
    body: confirmLayout({
      heading: `Remove ${app.name}?`,
      lede: `${app.name} will no longer be approved to use your Google accounts through ${COPY.product}.`,
      stops: [`${app.name} can no longer use any of your Google accounts.`, "To use it again, you would approve it again when it asks."],
      stays: [
        "Your Google accounts stay connected, with their Google services.",
        "Other AI apps keep their own access.",
        `Nothing is deleted at Google. ${COPY.trust.googleDataNotDeleted}`,
      ],
      action: html`<form method="post" action="/connections/client-revoke" class="inline"><input type="hidden" name="csrf" value="${p.user.csrf}"><input type="hidden" name="client" value="${app.id}"><button type="submit" class="btn btn-destructive">Remove ${app.name}</button></form>`,
      cancelHref: `/apps/${encodeURIComponent(app.id)}`,
    }),
  });
}

export async function appRemovePage(c: AppContext): Promise<Response> {
  const ctx = await pageContext(c, signedIn(c));
  const id = boundedId(c.req.param("id"));
  const app = id === undefined ? undefined : ctx.model.app(id);
  if (!app) return notFoundPage(c);
  return sendPage(c, await renderAppRemovePage({ user: ctx.user, model: ctx.model, app, flash: ctx.flash ? genericFlash(ctx.flash, ctx.model) : null }));
}
