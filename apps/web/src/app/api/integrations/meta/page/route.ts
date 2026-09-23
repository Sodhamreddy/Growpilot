export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, requireRole, open, config } from "@ob/core";
import { businesses, integrations, repo } from "@ob/db";
import { JOBS, payloadFrom } from "@ob/jobs";
import { route, parseBody } from "@/lib/api";
import { db, getQueues } from "@/lib/services";

/**
 * GET  /api/integrations/meta/page — the pages this connection can reach.
 * PATCH — choose which one belongs to the client on screen.
 *
 * One Meta login routinely administers pages for a dozen unrelated
 * businesses; an agency account reached fifteen here. The connection alone
 * therefore cannot say whose numbers are whose, and syncing everything under
 * one client would put another business's audience on their dashboard — a
 * mistake nothing downstream could detect, because the figures are real.
 *
 * So the page is chosen per client, and the choice lives on the business row
 * rather than on the integration. A workspace has one connection and many
 * clients; the mapping belongs at the end that varies.
 */

interface SealedCredential {
  userToken: string;
  pages: { id: string; name: string; accessToken: string; instagramId?: string }[];
}

/** Read the stored connection, or explain why there is nothing to read. */
async function loadPages(workspaceId: string): Promise<SealedCredential["pages"]> {
  const database = db();
  const [connection] = await database
    .select({ credentialSealed: integrations.credentialSealed })
    .from(integrations)
    .where(and(
      eq(integrations.workspaceId, workspaceId),
      eq(integrations.provider, "facebook"),
    ))
    .limit(1);

  if (!connection?.credentialSealed) {
    throw new AppError("not_found", "Facebook is not connected for this workspace.", {
      retryable: false,
    });
  }

  try {
    const credential = JSON.parse(
      open(connection.credentialSealed, config().CREDENTIAL_ENCRYPTION_KEY),
    ) as SealedCredential;
    return credential.pages;
  } catch {
    throw new AppError("internal", "The stored Facebook credential could not be read. Reconnect the account.", {
      retryable: false,
    });
  }
}

export const GET = route(async (ctx) => {
  const database = db();
  const [pages, business] = await Promise.all([
    loadPages(ctx.workspaceId),
    repo.getPrimaryBusiness(database, ctx),
  ]);

  /*
   * Which pages are already taken, and by whom.
   *
   * Two clients pointing at one page would double-count the same audience
   * under two names. Rather than forbidding it outright — an agency may
   * genuinely run one page for two records — the UI says who else is using
   * it and lets a person decide.
   */
  const claimed = await database
    .select({ id: businesses.id, name: businesses.name, metaPageId: businesses.metaPageId })
    .from(businesses)
    .where(eq(businesses.workspaceId, ctx.workspaceId));

  const takenBy = new Map(
    claimed
      .filter((row) => row.metaPageId && row.id !== business?.id)
      .map((row) => [row.metaPageId!, row.name]),
  );

  return {
    // Access tokens are deliberately not included: the browser has no use for
    // them and they are the one part of this worth stealing.
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      instagram: Boolean(page.instagramId),
      takenBy: takenBy.get(page.id) ?? null,
    })),
    selectedPageId: business?.metaPageId ?? null,
    businessName: business?.name ?? null,
  };
});

const schema = z.object({
  /** Null clears the choice, which stops this client syncing. */
  pageId: z.string().min(1).nullable(),
});

export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, schema);
  const database = db();

  const business = await repo.getPrimaryBusiness(database, ctx);
  if (!business) {
    throw new AppError("validation_failed", "Select a client first.", { retryable: false });
  }

  let pageName: string | null = null;
  if (body.pageId) {
    // Confirm the page is actually in this connection rather than trusting an
    // id from the browser: otherwise a typo silently stores a page that will
    // never sync, and the failure appears much later as an empty dashboard.
    const pages = await loadPages(ctx.workspaceId);
    const page = pages.find((p) => p.id === body.pageId);
    if (!page) {
      throw new AppError("validation_failed", "That Page is not part of the current connection.", {
        retryable: false,
      });
    }
    pageName = page.name;
  }

  await database
    .update(businesses)
    .set({ metaPageId: body.pageId, metaPageName: pageName, updatedAt: new Date() })
    .where(and(
      eq(businesses.workspaceId, ctx.workspaceId),
      eq(businesses.id, business.id),
    ));

  await repo.writeAudit(database, ctx, {
    action: "integration.page_selected",
    entityType: "business",
    entityId: business.id,
    before: { page: business.metaPageName ?? null },
    after: { page: pageName },
  });

  /*
   * Sync on selection, not only on connection.
   *
   * Choosing a page is the moment this client's numbers become fetchable, and
   * waiting for a schedule would leave an empty dashboard that looks like the
   * choice did not take.
   */
  let syncing = false;
  if (body.pageId) {
    try {
      await getQueues().enqueue(
        "analytics",
        JOBS.ingestMetrics,
        payloadFrom(ctx, { businessId: business.id, days: 30 }),
        { idempotencyKey: `meta-sync:${business.id}:${Date.now()}` },
      );
      syncing = true;
    } catch {
      syncing = false;
    }
  }

  return { ok: true, pageName, syncing };
});
