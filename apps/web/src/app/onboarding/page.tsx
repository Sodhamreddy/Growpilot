import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getSession, requireTenant } from "@/lib/auth";
import { db } from "@/lib/services";
import { workspaces } from "@ob/db";
import { readState, resumeAt } from "@/lib/onboarding";
import { Wizard } from "@/components/onboarding/Wizard";

/**
 * Onboarding entry — spec §2.2.
 *
 * Resumes from the server's record of completed steps, so a refresh or a
 * closed tab never restarts the flow.
 */

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  if (!await getSession()) redirect("/signin");
  const ctx = await requireTenant();

  const [ws] = await db()
    .select({ settings: workspaces.settings, completedAt: workspaces.onboardingCompletedAt })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  if (ws?.completedAt) redirect("/home");

  const state = readState(ws?.settings);
  return <Wizard initial={{ ...state, startAt: resumeAt(state) }} />;
}
