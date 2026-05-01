import { buildReminderTools } from "./reminders";
import { buildWebSearchTool } from "./web-search";
import { buildMemoryTools } from "./memory";
import { buildEmailTools } from "./email";
import { buildCalendarTools } from "./calendar";
import { buildDriveTools } from "./drive";
import { buildGoogleAccountTools } from "./google-accounts";
import { buildStagedMediaTools } from "./staged-media";
import { buildSettingsTools } from "./settings";
import { buildTaskTools } from "./tasks";
import { buildContactTools } from "./contacts";
import { buildHelpTools } from "./help";
import { buildExportTools } from "./export";
import { buildGmailInboxTools } from "./gmail-inbox";
import { buildMediaAiTools } from "./media-ai";
import { buildScheduledEmailTools } from "./scheduled-email";
import { buildSentHistoryTools } from "./sent-history";
import { buildFinanceTools } from "./finance";
import { buildWeatherTools } from "./weather";
import { buildNewsTools } from "./news";
import { hasGoogleOAuth, hasQStash, env } from "@/lib/env";

/**
 * Returns the FULL tool registry bound to a single user. Used on the primary
 * (Gemini) path. Tools that depend on unconfigured services are omitted.
 */
export function toolsForUser(userId: string) {
  return {
    ...buildHelpTools(),
    ...buildFinanceTools(),
    ...buildWeatherTools(),
    ...(env().TAVILY_API_KEY ? buildNewsTools() : {}),
    ...buildSettingsTools(userId),
    ...buildMemoryTools(userId),
    ...buildTaskTools(userId),
    ...buildExportTools(userId),
    ...buildSentHistoryTools(userId),
    ...buildMediaAiTools(userId),
    ...(hasQStash() ? buildReminderTools(userId) : {}),
    ...(env().TAVILY_API_KEY ? buildWebSearchTool() : {}),
    ...(hasGoogleOAuth() ? buildEmailTools(userId) : {}),
    ...(hasGoogleOAuth() ? buildCalendarTools(userId) : {}),
    ...(hasGoogleOAuth() ? buildDriveTools(userId) : {}),
    ...(hasGoogleOAuth() ? buildGmailInboxTools(userId) : {}),
    ...(hasGoogleOAuth() ? buildContactTools(userId) : {}),
    ...(hasGoogleOAuth() ? buildGoogleAccountTools(userId) : {}),
    ...(hasGoogleOAuth() && hasQStash() ? buildScheduledEmailTools(userId) : {}),
    ...buildStagedMediaTools(userId),
  };
}

/**
 * Slim registry for fallback path (Groq). Cuts the tool list from ~50 to ~12
 * to stay under tight TPM limits and to be more legible to weaker models.
 * Picks the tools that handle 90% of real requests; specialty tools are dropped.
 */
export function coreToolsForUser(userId: string) {
  const all = toolsForUser(userId);
  const keep = [
    "show_help",
    "remember", "list_memories",
    "stock_price", "stock_history", "crypto_price", "fx_rate", "weather", "web_search", "news_search",
    "set_reminder", "list_reminders",
    "add_task", "list_tasks", "complete_task",
    "contacts_search",
    "draft_email", "draft_calendar_event", "calendar_today", "calendar_week",
    "ocr_image", "transcribe_audio",
  ] as const;
  const out: Record<string, unknown> = {};
  for (const name of keep) {
    if (name in all) out[name] = (all as Record<string, unknown>)[name];
  }
  return out as Pick<ReturnType<typeof toolsForUser>, (typeof keep)[number]>;
}
