import { google } from "googleapis";
import { generateText } from "ai";
import { extractorModel } from "./provider";
import { getGoogleClient, hasGoogleConnection } from "@/lib/tools/google-auth";
import { listTasks } from "@/lib/memory/tasks";
import { listReminders } from "@/lib/tools/reminders";
import { env } from "@/lib/env";

function formatTimeRemaining(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "< 1m";
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Build a daily morning briefing for a single user. Pulls today's calendar,
 * open tasks, and (optionally) recent unread Gmail. Returns a single short
 * push-ready string.
 */
export async function buildMorningBriefing(
  userId: string,
  opts: { timezone: string; location: string | null; includeInbox: boolean },
): Promise<string | null> {
  const sections: string[] = [];
  const now = Date.now();

  // ⏰ Upcoming reminders (next 24h), with time remaining
  try {
    const allReminders = await listReminders(userId);
    const upcoming = allReminders
      .filter((r) => !r.cron && r.fireAt > now && r.fireAt < now + 24 * 60 * 60 * 1000)
      .sort((a, b) => a.fireAt - b.fireAt);
    if (upcoming.length) {
      const lines = upcoming.map((r) => `• ${r.message} — in ${formatTimeRemaining(r.fireAt - now)}`);
      sections.push(`⏰ Reminders today\n${lines.join("\n")}`);
    }
  } catch {
    // reminders not configured or Redis error — skip silently
  }

  // Calendar today
  if (await hasGoogleConnection(userId)) {
    try {
      const { client } = await getGoogleClient(userId, undefined, [
        "https://www.googleapis.com/auth/calendar.readonly",
      ]);
      const calendar = google.calendar({ version: "v3", auth: client });
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      const r = await calendar.events.list({
        calendarId: "primary",
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 10,
      });
      const events = (r.data.items ?? []).map((e) => ({
        summary: e.summary ?? "(untitled)",
        start: e.start?.dateTime ?? e.start?.date ?? "",
      }));
      if (events.length) {
        const lines = events
          .map((e) => {
            const t = e.start
              ? new Date(e.start).toLocaleTimeString("en-US", {
                  timeZone: opts.timezone,
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "?";
            return `• ${t} — ${e.summary}`;
          })
          .join("\n");
        sections.push(`📅 Today\n${lines}`);
      } else {
        sections.push("📅 Today\nNo events on your calendar.");
      }
    } catch (err) {
      console.warn("[briefing] calendar fetch failed", err);
    }
  }

  // Open tasks — overdue first, then due within 24h
  const open = await listTasks(userId, "open");
  if (open.length) {
    const overdue = open
      .filter((t) => t.dueAt && t.dueAt < now)
      .slice(0, 5)
      .map((t) => `• [OVERDUE] ${t.title}`);
    const dueSoon = open
      .filter((t) => t.dueAt && t.dueAt >= now && t.dueAt < now + 24 * 60 * 60 * 1000)
      .slice(0, 5)
      .map((t) => `• ${t.title} (due ${new Date(t.dueAt!).toLocaleTimeString("en-US", { timeZone: opts.timezone, hour: "numeric", minute: "2-digit" })})`);
    const taskLines = [...overdue, ...dueSoon];
    if (taskLines.length) {
      sections.push(`📋 Tasks\n${taskLines.join("\n")}`);
    } else {
      sections.push(`📋 ${open.length} open task(s) — none due today.`);
    }
  }

  // Inbox
  if (opts.includeInbox && (await hasGoogleConnection(userId))) {
    try {
      const { client } = await getGoogleClient(userId, undefined, [
        "https://www.googleapis.com/auth/gmail.readonly",
      ]);
      const gmail = google.gmail({ version: "v1", auth: client });
      const list = await gmail.users.messages.list({
        userId: "me",
        q: "newer_than:1d is:unread category:primary",
        maxResults: 8,
      });
      const ids = (list.data.messages ?? []).map((m) => m.id ?? "").filter(Boolean);
      if (ids.length) {
        const fetched = await Promise.all(
          ids.map((id) =>
            gmail.users.messages.get({
              userId: "me",
              id,
              format: "metadata",
              metadataHeaders: ["From", "Subject"],
            }),
          ),
        );
        const items = fetched.map((r) => {
          const headers = r.data.payload?.headers ?? [];
          const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
          const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
          return `• ${subject} — ${from.split("<")[0]?.trim() || from}`;
        });
        sections.push(`📧 Unread (last 24h)\n${items.join("\n")}`);
      }
    } catch (err) {
      console.warn("[briefing] gmail fetch failed", err);
    }
  }

  if (!sections.length) return null;

  // Optional: have the LLM polish the briefing into a friendly intro.
  try {
    const prelude = `Good morning! Here's your day:\n\n${sections.join("\n\n")}`;
    const r = await generateText({
      model: extractorModel(),
      system:
        "You are Lekha, a personal assistant. Take this briefing skeleton and add a single warm one-line intro. Output the briefing in full — keep all sections verbatim. No emoji headers should be removed. Total under 1500 chars.",
      prompt: prelude,
    });
    const polished = r.text.trim();
    return polished.length > 50 ? polished : prelude;
  } catch {
    return `Good morning. Here's your day:\n\n${sections.join("\n\n")}`;
  }
}

/** Used by the cron sweep to know if we should push the briefing now. */
export function shouldFireBriefingNow(
  briefingTime: string | null,
  lastFiredTs: number | null,
  timezone: string,
  windowMinutes = 15,
): boolean {
  if (!briefingTime) return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(briefingTime);
  if (!m) return false;
  const hh = parseInt(m[1]!, 10);
  const mm = parseInt(m[2]!, 10);
  const nowLocalParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const localHour = parseInt(nowLocalParts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const localMin = parseInt(nowLocalParts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const nowMinOfDay = localHour * 60 + localMin;
  const targetMinOfDay = hh * 60 + mm;
  const within = nowMinOfDay >= targetMinOfDay && nowMinOfDay - targetMinOfDay < windowMinutes;
  if (!within) return false;
  // Don't fire twice in the same day.
  if (lastFiredTs && Date.now() - lastFiredTs < 12 * 60 * 60 * 1000) return false;
  return true;
}

// Marker import to keep `env` reachable for tree-shaking checks.
void env;
