import { NextResponse, type NextRequest } from "next/server";
import { Receiver } from "@upstash/qstash";
import { google } from "googleapis";
import { env, hasQStash } from "@/lib/env";
import { listAllUsers } from "@/lib/memory/user-registry";
import { getSettings, updateSettings } from "@/lib/memory/settings";
import { hasGoogleConnection, getGoogleClient } from "@/lib/tools/google-auth";
import { redis } from "@/lib/memory/redis";
import { push, text as textMsg } from "@/lib/line/client";
import { buildMorningBriefing, shouldFireBriefingNow } from "@/lib/llm/briefing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proactive cron sweep. QStash hits this on a fixed schedule (every 15 min recommended).
 * For each registered user, decide what to push:
 *  - Daily morning briefing (if their local-time window matches their setting)
 *  - Pre-meeting reminders (any event starting within their lead-time)
 */
export async function POST(req: NextRequest) {
  if (!hasQStash()) return new NextResponse("not configured", { status: 503 });
  const raw = await req.text();
  const sig = req.headers.get("upstash-signature") ?? req.headers.get("Upstash-Signature");
  // Allow a manual trigger via Authorization: Bearer <OAUTH_STATE_SECRET> for ops/testing.
  const auth = req.headers.get("authorization");
  const allowManual = auth === `Bearer ${env().OAUTH_STATE_SECRET}`;

  if (!allowManual) {
    if (!sig) return new NextResponse("missing signature", { status: 401 });
    const receiver = new Receiver({
      currentSigningKey: env().QSTASH_CURRENT_SIGNING_KEY!,
      nextSigningKey: env().QSTASH_NEXT_SIGNING_KEY ?? env().QSTASH_CURRENT_SIGNING_KEY!,
    });
    try {
      const ok = await receiver.verify({
        signature: sig,
        body: raw,
        url: `${env().APP_BASE_URL}/api/cron/sweep`,
      });
      if (!ok) return new NextResponse("invalid signature", { status: 401 });
    } catch {
      return new NextResponse("invalid signature", { status: 401 });
    }
  }

  const users = await listAllUsers();
  const stats = { briefings: 0, preMeetingPushes: 0, errors: 0, users: users.length };

  await Promise.all(
    users.map(async (userId) => {
      try {
        const settings = await getSettings(userId);

        // Morning briefing
        if (
          settings.morningBriefingTime &&
          shouldFireBriefingNow(
            settings.morningBriefingTime,
            settings.lastMorningBriefingTs,
            settings.timezone,
          )
        ) {
          const briefing = await buildMorningBriefing(userId, {
            timezone: settings.timezone,
            location: settings.location,
            includeInbox: settings.inboxBriefingEnabled,
          });
          if (briefing) {
            await push(userId, [textMsg(briefing)]);
            await updateSettings(userId, { lastMorningBriefingTs: Date.now() });
            stats.briefings++;
          }
        }

        // Pre-meeting reminders
        if (
          settings.preMeetingMinutes != null &&
          settings.preMeetingMinutes > 0 &&
          (await hasGoogleConnection(userId))
        ) {
          await sweepPreMeetingPushes(userId, settings.preMeetingMinutes, settings.timezone, stats);
        }
      } catch (err) {
        stats.errors++;
        console.error("[sweep] user failed", userId, err);
      }
    }),
  );

  return NextResponse.json({ ok: true, stats });
}

async function sweepPreMeetingPushes(
  userId: string,
  leadMinutes: number,
  timezone: string,
  stats: { preMeetingPushes: number },
): Promise<void> {
  const { client } = await getGoogleClient(userId, undefined, [
    "https://www.googleapis.com/auth/calendar.readonly",
  ]);
  const calendar = google.calendar({ version: "v3", auth: client });
  const now = Date.now();
  const max = now + leadMinutes * 60 * 1000 + 16 * 60 * 1000; // sweep window + slack
  const r = await calendar.events.list({
    calendarId: "primary",
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(max).toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 10,
  });
  for (const e of r.data.items ?? []) {
    const startISO = e.start?.dateTime ?? e.start?.date;
    if (!startISO || !e.id) continue;
    const startTs = new Date(startISO).getTime();
    const minutesUntil = Math.round((startTs - now) / 60_000);
    if (minutesUntil > leadMinutes || minutesUntil < leadMinutes - 16) continue;
    // Idempotency: don't push twice for same event.
    const seenKey = `premeet:${userId}:${e.id}`;
    const set = await redis().set(seenKey, 1, { ex: 60 * 60 * 6, nx: true });
    if (set === null) continue;
    const local = new Date(startTs).toLocaleTimeString("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    });
    const where = e.location ? ` @ ${e.location}` : "";
    await push(userId, [
      textMsg(`🔔 In ~${minutesUntil} min: ${e.summary ?? "(untitled)"} at ${local}${where}.`),
    ]);
    stats.preMeetingPushes++;
  }
}
