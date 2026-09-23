export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";
import { jsonError } from "@/lib/api";

/** POST /api/auth/signout */
export async function POST(): Promise<NextResponse> {
  try {
    await destroySession();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
