import { eq } from "drizzle-orm";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { workspaces } from "@ob/db";
import { TopBar } from "@/components/TopBar";
import { PreferencesForm } from "@/components/PreferencesForm";

/**
 * Preferences — spec §15.1 workspace policy.
 *
 * Fully working: every control here is read by the publishing gate or the AI
 * gateway at runtime.
 */

export const dynamic = "force-dynamic";

export default async function PreferencesPage() {
  const ctx = await requireTenant();
  const session = await getSession();
  const initials =
    (session?.name ?? session?.email ?? "?").split(/[\s@.]+/).filter(Boolean)
      .slice(0, 2).map((c) => c[0]!.toUpperCase()).join("") || "?";

  const [ws] = await db()
    .select({
      name: workspaces.name,
      timezone: workspaces.timezone,
      plan: workspaces.plan,
      settings: workspaces.settings,
      aiBudgetMicros: workspaces.aiBudgetMicros,
    })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  const canEdit = ctx.role === "owner" || ctx.role === "admin";

  return (
    <>
      <TopBar section="Configure" page="Preferences" initials={initials} />
      <div className="content">
        <div className="pagehead">
          <div className="titlerow">
            <h1>Preferences</h1>
            <span className="badge neutral">{ws?.plan ?? "trial"} plan</span>
          </div>
          <p>
            Workspace policy. These settings are enforced by the publishing gate and the AI
            gateway — changing them changes what the pipeline does.
          </p>
        </div>

        <PreferencesForm
          canEdit={canEdit}
          initial={{
            name: ws?.name ?? "",
            timezone: ws?.timezone ?? "UTC",
            requireApprovalBeforePublish: ws?.settings.requireApprovalBeforePublish !== false,
            requireHumanReviewForSensitive: ws?.settings.requireHumanReviewForSensitive !== false,
            autoPublishEnabled: ws?.settings.autoPublishEnabled === true,
            minSeoScoreToPublish: ws?.settings.minSeoScoreToPublish ?? 70,
            minVoiceScoreToPublish: ws?.settings.minVoiceScoreToPublish ?? 70,
            aiBudgetUsd: (ws?.aiBudgetMicros ?? 0) / 1_000_000,
          }}
        />
      </div>
    </>
  );
}
