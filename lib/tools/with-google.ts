import { getGoogleClient, buildConnectUrl } from "./google-auth";
import { GoogleAuthRequired } from "@/lib/errors";

export type AuthRequiredResult = {
  ok: false;
  need_google_auth: true;
  connect_url: string;
  reason: string;
};

/**
 * Run `fn` with an authorized Google client. If the user hasn't connected
 * Google or the stored tokens are missing required scopes, return a structured
 * result instead of throwing — the AI SDK swallows tool exceptions, so this
 * is how we surface auth-required state to both the model and the orchestrator.
 */
export async function withGoogleClient<T>(
  userId: string,
  fromEmail: string | undefined,
  requiredScopes: string[],
  fn: (ctx: { client: Awaited<ReturnType<typeof getGoogleClient>>["client"]; email: string }) => Promise<T>,
): Promise<T | AuthRequiredResult> {
  try {
    const { client, email } = await getGoogleClient(userId, fromEmail, requiredScopes);
    return await fn({ client, email });
  } catch (err) {
    if (err instanceof GoogleAuthRequired) {
      const reason = requiredScopes.length
        ? `Need to (re)authorize Google with these scopes: ${requiredScopes.join(", ")}`
        : "Need to authorize Google";
      return {
        ok: false,
        need_google_auth: true,
        connect_url: buildConnectUrl(userId),
        reason,
      };
    }
    throw err;
  }
}
