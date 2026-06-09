import { verifyDashboardToken } from "@/lib/dashboard-auth";
import { getSettings } from "@/lib/memory/settings";
import { getOrCreateProfile } from "@/lib/memory/profile";
import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let userId: string;
  try {
    userId = verifyDashboardToken(token);
  } catch {
    return (
      <main style={pageStyle}>
        <div style={logoStyle}>⚙️</div>
        <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>Link expired</h1>
        <p style={{ color: "#666", fontSize: "0.9rem" }}>
          Ask Lekha to send a new settings link (just say &ldquo;open settings&rdquo;).
        </p>
      </main>
    );
  }

  const [settings, profile] = await Promise.all([
    getSettings(userId),
    getOrCreateProfile(userId),
  ]);

  return (
    <main style={pageStyle}>
      <div style={logoStyle}>⚙️</div>
      <h1 style={titleStyle}>Lekha Settings</h1>
      {profile.displayName && (
        <p style={greetStyle}>สวัสดี, {profile.displayName} 👋</p>
      )}
      <DashboardClient token={token} initial={settings} />
      <p style={footerStyle}>
        การเปลี่ยนแปลงจะมีผลทันทีในการสนทนา LINE
        <br />
        <span style={{ color: "#aaa", fontSize: "0.78rem" }}>
          Changes take effect immediately in your LINE chat.
        </span>
      </p>
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  fontFamily: "system-ui, -apple-system, 'Helvetica Neue', sans-serif",
  maxWidth: 420,
  margin: "0 auto",
  padding: "2rem 1.25rem 3rem",
  minHeight: "100dvh",
  background: "#f5f5f7",
};

const logoStyle: React.CSSProperties = {
  fontSize: "2.5rem",
  textAlign: "center",
  marginBottom: "0.5rem",
};

const titleStyle: React.CSSProperties = {
  fontSize: "1.5rem",
  fontWeight: 700,
  textAlign: "center",
  marginBottom: "0.25rem",
  color: "#111",
};

const greetStyle: React.CSSProperties = {
  textAlign: "center",
  color: "#555",
  marginBottom: "1.5rem",
  fontSize: "0.95rem",
};

const footerStyle: React.CSSProperties = {
  marginTop: "1.25rem",
  textAlign: "center",
  fontSize: "0.82rem",
  color: "#888",
  lineHeight: 1.7,
};
