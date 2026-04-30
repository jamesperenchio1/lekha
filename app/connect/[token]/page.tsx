import { redirect } from "next/navigation";
import { startOAuth, verifyConnectToken } from "@/lib/tools/google-auth";

export const dynamic = "force-dynamic";

export default async function ConnectPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  let userId: string;
  try {
    userId = verifyConnectToken(token);
  } catch {
    return (
      <main style={pageStyle}>
        <h1>Link expired</h1>
        <p>Ask the bot to send you a fresh connect link, then tap it within 10 minutes.</p>
      </main>
    );
  }
  const consentUrl = await startOAuth(userId);
  redirect(consentUrl);
}

const pageStyle: React.CSSProperties = {
  fontFamily: "system-ui, -apple-system, sans-serif",
  maxWidth: 520,
  margin: "10vh auto",
  padding: "2rem",
  lineHeight: 1.5,
};
