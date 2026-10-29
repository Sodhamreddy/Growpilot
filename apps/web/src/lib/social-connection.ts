import { and, eq } from "drizzle-orm";
import { config, open, type TenantContext } from "@ob/core";
import { integrations, type Database } from "@ob/db";
import { PUBLISH_PERMISSIONS, storageKind } from "@ob/social";

/**
 * Whether a client can publish, network by network, and if not, why.
 *
 * Worked out from what is stored: the Meta connection, the permissions it was
 * actually granted, the Page chosen for this client, and whether images have
 * a public address. The schedule page shows this before anyone schedules, so
 * a missing permission is found on the page rather than at nine the next
 * morning when the post fails to go out.
 */

export interface NetworkReadiness {
  ok: boolean;
  /** What to do about it, when not ok. */
  reason: string | null;
}

export interface ConnectionSummary {
  connected: boolean;
  pageId?: string;
  instagramId?: string;
  pageName: string | null;
  hasPage: boolean;
  instagramLinked: boolean;
  facebook: NetworkReadiness;
  instagram: NetworkReadiness;
}

interface SealedCredential {
  pages: { id: string; name: string; instagramId?: string }[];
}

const missing = (granted: string[], needed: readonly string[]) => needed.filter((p) => !granted.includes(p));

export async function loadConnection(
  database: Database,
  ctx: TenantContext,
  business: { name: string; metaPageId: string | null } | null,
): Promise<ConnectionSummary> {
  const none = (reason: string): ConnectionSummary => ({
    connected: false, pageName: null, hasPage: false, instagramLinked: false,
    facebook: { ok: false, reason }, instagram: { ok: false, reason },
  });
  if (!business) return none("Add your business first.");

  const [row] = await database
    .select({ status: integrations.status, scopes: integrations.scopes, credentialSealed: integrations.credentialSealed })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.provider, "facebook")))
    .limit(1);
  if (!row?.credentialSealed || row.status !== "connected") {
    return none("Connect Facebook and Instagram to publish.");
  }

  let pages: SealedCredential["pages"] = [];
  try {
    pages = (JSON.parse(open(row.credentialSealed, config().CREDENTIAL_ENCRYPTION_KEY)) as SealedCredential).pages;
  } catch {
    return none("The stored connection could not be read. Reconnect it.");
  }

  const page = pages.find((p) => p.id === business.metaPageId) ?? null;
  const base = {
    connected: true,
    ...(page ? { pageId: page.id } : {}),
    ...(page?.instagramId ? { instagramId: page.instagramId } : {}),
    pageName: page?.name ?? null,
    hasPage: Boolean(page),
    instagramLinked: Boolean(page?.instagramId),
  };
  if (!page) {
    const reason = business.metaPageId
      ? `The Page chosen for ${business.name} is not reachable with this connection. Choose it again.`
      : `Choose which Facebook Page is ${business.name}'s.`;
    return { ...base, facebook: { ok: false, reason }, instagram: { ok: false, reason } };
  }

  /*
   * An empty scope list means a connection made before scopes were recorded,
   * not one granted nothing. It is treated as unknown and asked to reconnect,
   * which is also what adds the posting permissions it certainly lacks.
   */
  const granted = row.scopes ?? [];
  const fbMissing = missing(granted, PUBLISH_PERMISSIONS.facebook);
  const igMissing = missing(granted, PUBLISH_PERMISSIONS.instagram);

  const facebook: NetworkReadiness = fbMissing.length
    ? { ok: false, reason: "Reconnect to allow posting to the Page." }
    : { ok: true, reason: null };

  const instagram: NetworkReadiness = !page.instagramId
    ? { ok: false, reason: `No Instagram professional account is linked to ${page.name}. Link one in Meta Business settings, then reconnect.` }
    : igMissing.length
      ? { ok: false, reason: "Reconnect to allow posting to Instagram." }
      : storageKind() !== "supabase"
        ? { ok: false, reason: "Instagram needs images at a public address. Set up Supabase Storage in .env." }
        : { ok: true, reason: null };

  return { ...base, facebook, instagram };
}
