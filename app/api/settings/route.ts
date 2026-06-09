import { NextRequest, NextResponse } from "next/server";
import { verifyDashboardToken } from "@/lib/dashboard-auth";
import { getSettings, updateSettings } from "@/lib/memory/settings";
import { z } from "zod";

export const runtime = "nodejs";

function getUserId(req: NextRequest): string {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) throw new Error("missing token");
  return verifyDashboardToken(token);
}

export async function GET(req: NextRequest) {
  try {
    const userId = getUserId(req);
    const settings = await getSettings(userId);
    return NextResponse.json(settings);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json({ error: msg }, { status: 401 });
  }
}

const PatchBody = z.object({
  language: z.string().min(2).max(10).nullable(),
  timezone: z.string().min(3).max(60).optional(),
  location: z.string().min(2).max(120).nullable().optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const userId = getUserId(req);
    const body = PatchBody.parse(await req.json());
    const updated = await updateSettings(userId, body);
    return NextResponse.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    const status = msg === "missing token" || msg === "bad signature" || msg === "expired" ? 401 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
