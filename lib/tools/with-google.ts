import { getGoogleClient, buildConnectUrl } from "./google-auth";
import { GoogleAuthRequired } from "@/lib/errors";

export type AuthRequiredResult = {
  ok: false;
  need_google_auth: true;
  connect_url: string;
  reason: string;
};

export type ApiDisabledResult = {
  ok: false;
  google_api_disabled: true;
  api: string;
  enable_url: string | null;
  message: string;
};

export type GoogleErrorResult = {
  ok: false;
  google_error: true;
  status: number | null;
  message: string;
};

/**
 * Run `fn` with an authorized Google client. Catches three classes of failure
 * and returns structured results so the orchestrator can surface them cleanly
 * (the AI SDK swallows tool exceptions, so we can't rely on throws):
 *
 *  1. GoogleAuthRequired → user must (re)connect.
 *  2. "API has not been used / disabled" → user must enable the API in Cloud Console.
 *  3. Other Google API errors → surface message + status code.
 */
export async function withGoogleClient<T>(
  userId: string,
  fromEmail: string | undefined,
  requiredScopes: string[],
  fn: (ctx: {
    client: Awaited<ReturnType<typeof getGoogleClient>>["client"];
    email: string;
  }) => Promise<T>,
): Promise<T | AuthRequiredResult | ApiDisabledResult | GoogleErrorResult> {
  try {
    const { client, email } = await getGoogleClient(userId, fromEmail, requiredScopes);
    return await fn({ client, email });
  } catch (err) {
    if (err instanceof GoogleAuthRequired) {
      return {
        ok: false,
        need_google_auth: true,
        connect_url: buildConnectUrl(userId),
        reason: requiredScopes.length
          ? `Need to (re)authorize Google with these scopes: ${requiredScopes.join(", ")}`
          : "Need to authorize Google",
      };
    }
    // Refresh-token failures from a swapped-out OAuth client look like 'invalid_grant'
    // or 'invalid_client' — treat the same as needs-reauth.
    const msg = String((err as { message?: unknown })?.message ?? err);
    if (/invalid_grant|invalid_client|Token has been expired or revoked|unauthorized_client/i.test(msg)) {
      return {
        ok: false,
        need_google_auth: true,
        connect_url: buildConnectUrl(userId),
        reason: "Stored Google token is no longer valid (probably issued by a previous OAuth client) — please reconnect.",
      };
    }
    return classifyGoogleError(err);
  }
}

function classifyGoogleError(err: unknown): ApiDisabledResult | GoogleErrorResult {
  const e = err as {
    response?: { status?: number; data?: { error?: { message?: string; code?: number } } };
    status?: number;
    code?: number | string;
    message?: string;
  };
  const status = e?.response?.status ?? (typeof e?.code === "number" ? e.code : null) ?? e?.status ?? null;
  const message = e?.response?.data?.error?.message ?? e?.message ?? String(err);
  console.error("[google] api error", { status, message });

  if (typeof message === "string" && /API has not been used|is disabled|has not been enabled/i.test(message)) {
    const apiMatch = message.match(/(\w[\w. ]*?)\s*has not been used in project|Enable it by visiting (https:\S+)/);
    const urlMatch = message.match(/(https:\/\/console\.(?:developers|cloud)\.google\.com\/\S+)/);
    return {
      ok: false,
      google_api_disabled: true,
      api: apiMatch?.[1] ?? "Google API",
      enable_url: urlMatch?.[1] ?? null,
      message,
    };
  }

  return {
    ok: false,
    google_error: true,
    status: typeof status === "number" ? status : null,
    message: String(message).slice(0, 500),
  };
}
