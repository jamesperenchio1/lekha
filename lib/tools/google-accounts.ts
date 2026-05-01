import { z } from "zod";
import { tool } from "ai";
import { listAccounts, setActiveAccount, removeAccount, buildConnectUrl } from "./google-auth";

export function buildGoogleAccountTools(userId: string) {
  return {
    list_google_accounts: tool({
      description:
        "List the Google accounts the user has connected. Shows which one is active (used for email/calendar/drive by default).",
      inputSchema: z.object({}),
      execute: async () => {
        const blob = await listAccounts(userId);
        return {
          accounts: blob.accounts.map((a) => ({
            email: a.email,
            isActive: a.email === blob.activeEmail,
          })),
          activeEmail: blob.activeEmail,
        };
      },
    }),

    connect_google_account: tool({
      description:
        "Generate a connect link for the user to add a Google account (or add another). The link must be tapped from LINE; OAuth happens in the browser. New accounts become active automatically.",
      inputSchema: z.object({}),
      execute: async () => {
        const url = await buildConnectUrl(userId);
        return {
          url,
          note: "Link expires in 10 minutes. After connecting, the new account becomes active.",
        };
      },
    }),

    switch_google_account: tool({
      description:
        "Switch which connected Google account is the active default for email/calendar/drive. Pass the account's email.",
      inputSchema: z.object({ email: z.string().email() }),
      execute: async ({ email }) => {
        const ok = await setActiveAccount(userId, email);
        return ok
          ? { ok: true, activeEmail: email }
          : { ok: false, error: `${email} is not connected. Use list_google_accounts to see options.` };
      },
    }),

    disconnect_google_account: tool({
      description:
        "Remove a connected Google account. The user can re-add it later with connect_google_account.",
      inputSchema: z.object({ email: z.string().email() }),
      execute: async ({ email }) => {
        const ok = await removeAccount(userId, email);
        return ok ? { ok: true } : { ok: false, error: `${email} was not connected.` };
      },
    }),
  };
}
