import { Client as QStash } from "@upstash/qstash";
import { env, hasQStash } from "@/lib/env";

function qstash() {
  if (!hasQStash()) throw new Error("QStash not configured");
  return new QStash({ token: env().QSTASH_TOKEN! });
}

/**
 * Schedule a recurring HTTP POST at a given cron expression.
 * Returns the QStash schedule id (store in Redis if you need to cancel later).
 *
 * NOTE: QStash crons are evaluated in UTC. Convert from user-local TZ before passing.
 */
export async function scheduleRecurring(
  pathFromBase: string,
  body: Record<string, unknown>,
  cronUtc: string,
): Promise<string> {
  const url = `${env().APP_BASE_URL}${pathFromBase}`;
  const r = await qstash().schedules.create({
    destination: url,
    cron: cronUtc,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return r.scheduleId;
}

export async function cancelSchedule(scheduleId: string): Promise<void> {
  try {
    await qstash().schedules.delete(scheduleId);
  } catch {
    // already gone
  }
}

export async function scheduleOneShot(
  pathFromBase: string,
  body: Record<string, unknown>,
  delaySec: number,
): Promise<string> {
  const url = `${env().APP_BASE_URL}${pathFromBase}`;
  const r = await qstash().publishJSON({
    url,
    body,
    delay: delaySec,
  });
  return r.messageId;
}

/**
 * Convert HH:mm in a given IANA timezone to a UTC cron "min hour * * *" expression.
 * Approximation: uses the current UTC offset of that TZ. DST transitions can cause
 * the briefing to land an hour off twice a year — acceptable for v1.
 */
export function localTimeToUtcCron(hhmm: string, timezone: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  // Compute the TZ offset for "today" at the requested wall-clock time.
  const now = new Date();
  const local = new Date(
    now.toLocaleString("en-US", { timeZone: timezone }),
  );
  const offsetMs = local.getTime() - now.getTime();
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min);
  const utc = new Date(localMidnight.getTime() - offsetMs);
  return `${utc.getUTCMinutes()} ${utc.getUTCHours()} * * *`;
}
