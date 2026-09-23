import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { workspaces } from "@ob/db";

export default async function Index() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const [ws] = await db()
    .select({ done: workspaces.onboardingCompletedAt })
    .from(workspaces)
    .where(eq(workspaces.id, session.workspaceId))
    .limit(1);

  redirect(ws?.done ? "/home" : "/onboarding");
}
