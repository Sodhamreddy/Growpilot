export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";
import { AppError, config, requireRole, type TenantContext } from "@ob/core";
import { businesses, businessLocations, gmbReviews, repo, type GoogleListing } from "@ob/db";
import {
  listingSelection, GoogleApiError, gbpAccessToken, googleCredentials, isMapsLink, listGbpLocations, placeReviews, searchPlaces,
} from "@ob/gmb";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";
import { queueReviewSync } from "@/lib/reviews";

/**
 * Which Google listing is this client's.
 *
 * GET  ?q=…        search Google Maps (Places API) for listings, to pick from
 * GET  ?source=gbp the listings the connected Google account manages
 * PATCH            choose one, then read its reviews straight away
 * DELETE           forget the choice and the reviews read from it
 *
 * Chosen by a person, never matched by name: namesakes are common, and a
 * reply posted to the wrong business's review cannot be taken back quietly.
 */

const asAppError = (err: unknown): never => {
  if (err instanceof GoogleApiError) throw new AppError("provider_error", err.message, { retryable: !err.permanent });
  throw err;
};

async function currentBusiness(ctx: TenantContext) {
  const business = await repo.getPrimaryBusiness(db(), ctx);
  if (!business) throw new AppError("validation_failed", "Select a client first.", { retryable: false });
  return business;
}

export const GET = route(async (ctx, req) => {
  const params = new URL(req.url).searchParams;
  const creds = googleCredentials(config());
  const database = db();

  if (params.get("source") === "gbp") {
    const token = await gbpAccessToken(database, ctx, creds).catch(asAppError);
    if (!token) throw new AppError("conflict", "Connect Google first.", { retryable: false });
    const locations = await listGbpLocations(token).catch(asAppError);
    return { locations };
  }

  const business = await currentBusiness(ctx);
  let q = (params.get("q") ?? "").trim();
  if (!q) {
    // First look: the client's own name and address, as recorded.
    const [loc] = await database.select().from(businessLocations)
      .where(and(eq(businessLocations.workspaceId, ctx.workspaceId), eq(businessLocations.businessId, business.id))).limit(1);
    q = [business.gmbName ?? business.name, loc?.streetAddress, loc?.locality, loc?.region].filter(Boolean).join(" ");
  }
  if (!creds.mapsKey) {
    throw new AppError("validation_failed", "Add GOOGLE_MAPS_API_KEY to .env (a key with Places API (New) turned on) to search Google.", { retryable: false });
  }
  const places = await searchPlaces(creds.mapsKey, q.slice(0, 200)).catch(asAppError);
  return { query: q, places };
});

const chooseSchema = z.union([
  z.object({ mapsLink: z.string().trim().url().max(2000) }),
  z.object({ placeId: z.string().min(3).max(300) }),
  z.object({ gbpLocation: z.string().regex(/^accounts\/[^/]+\/locations\/[^/]+$/) }),
]);

export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, chooseSchema);
  const cfg = config();
  const creds = googleCredentials(cfg);
  const database = db();
  const business = await currentBusiness(ctx);
  let selected: GoogleListing;

  if ("mapsLink" in body) {
    if (!isMapsLink(body.mapsLink)) {
      throw new AppError("validation_failed", "That is not a Google Maps link. Open the business on Google Maps, press Share, and copy the link.", { retryable: false });
    }
    selected = { mapsLink: body.mapsLink, mapsUri: body.mapsLink };
  } else if ("gbpLocation" in body) {
    // Confirm the account really manages it, rather than trusting an id from the browser.
    const token = await gbpAccessToken(database, ctx, creds).catch(asAppError);
    if (!token) throw new AppError("conflict", "Connect Google first.", { retryable: false });
    const location = (await listGbpLocations(token).catch(asAppError)).find((l) => l.name === body.gbpLocation);
    if (!location) throw new AppError("validation_failed", "That listing is not one this Google account manages.", { retryable: false });
    selected = {
      gbpLocation: location.name, gbpTitle: location.title, title: location.title,
      ...(location.placeId ? { placeId: location.placeId } : {}),
      ...(location.address ? { address: location.address } : {}),
      ...(location.mapsUri ? { mapsUri: location.mapsUri } : {}),
    };
  } else {
    if (!creds.mapsKey) throw new AppError("validation_failed", "Add GOOGLE_MAPS_API_KEY to .env to use Google Maps listings.", { retryable: false });
    const { place } = await placeReviews(creds.mapsKey, body.placeId).catch(asAppError);
    selected = { placeId: place.placeId, title: place.title,
      ...(place.address ? { address: place.address } : {}), ...(place.mapsUri ? { mapsUri: place.mapsUri } : {}) };
  }

  const { listing, changed } = listingSelection(business.googleListing, selected);
  await database.transaction(async (tx) => {
    const updated = await tx.update(businesses).set({ googleListing: listing, updatedAt: new Date() })
      .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, business.id),
        (business.googleListing ? sql`${businesses.googleListing} = ${JSON.stringify(business.googleListing)}::jsonb` : sql`${businesses.googleListing} IS NULL`)))
      .returning({ id: businesses.id });
    if (!updated.length) throw new AppError("conflict", "The Google listing changed. Refresh and choose it again.", { retryable: false });
    if (changed) await tx.delete(gmbReviews).where(and(eq(gmbReviews.workspaceId, ctx.workspaceId),
      eq(gmbReviews.businessId, business.id), ne(gmbReviews.source, "manual")));
  });

  await repo.writeAudit(database, ctx, {
    action: "reviews.listing_selected", entityType: "business", entityId: business.id,
    after: { placeId: listing.placeId, gbpLocation: listing.gbpLocation, mapsLink: listing.mapsLink },
  });

  const jobId = await queueReviewSync(ctx, business.id);
  return { ok: true, listing, queued: true, jobId };
});

export const DELETE = route(async (ctx) => {
  requireRole(ctx, "editor");
  const database = db();
  const business = await currentBusiness(ctx);
  await database.transaction(async (tx) => {
    await tx.update(businesses).set({ googleListing: null, updatedAt: new Date() })
      .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, business.id)));
    await tx.delete(gmbReviews).where(and(eq(gmbReviews.workspaceId, ctx.workspaceId), eq(gmbReviews.businessId, business.id), ne(gmbReviews.source, "manual")));
  });
  await repo.writeAudit(database, ctx, { action: "reviews.listing_cleared", entityType: "business", entityId: business.id });
  return { ok: true };
});
