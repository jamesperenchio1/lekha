import { redis } from "./redis";

export type UserSettings = {
  /** IANA timezone, e.g. "Asia/Bangkok". Defaults below if unset. */
  timezone: string;
  /** BCP-47 language tag the user prefers replies in, e.g. "en", "th". null = auto-detect. */
  language: string | null;
  /** Optional human-readable location label ("Bangkok, Thailand"). */
  location: string | null;
  /** Daily morning-briefing time in HH:mm 24h, in user's timezone. null = disabled. */
  morningBriefingTime: string | null;
  /** Pre-meeting reminder lead in minutes. null = disabled. */
  preMeetingMinutes: number | null;
  /** Whether to auto-summarize unread Gmail in the morning briefing. */
  inboxBriefingEnabled: boolean;
  /** Last time we ran the morning briefing for this user (ms). */
  lastMorningBriefingTs: number | null;
  /** Set of disabled tool categories — used to gate tools the user opted out of. */
  disabledCategories: string[];
  updatedAt: number;
};

const DEFAULTS: UserSettings = {
  timezone: "Asia/Bangkok",
  language: null,
  location: null,
  morningBriefingTime: null,
  preMeetingMinutes: null,
  inboxBriefingEnabled: false,
  lastMorningBriefingTs: null,
  disabledCategories: [],
  updatedAt: 0,
};

const key = (userId: string) => `user:${userId}:settings`;

export async function getSettings(userId: string): Promise<UserSettings> {
  const v = await redis().get<Partial<UserSettings>>(key(userId));
  return { ...DEFAULTS, ...(v ?? {}) };
}

export async function updateSettings(
  userId: string,
  patch: Partial<UserSettings>,
): Promise<UserSettings> {
  const cur = await getSettings(userId);
  const next: UserSettings = { ...cur, ...patch, updatedAt: Date.now() };
  await redis().set(key(userId), next);
  return next;
}
