"use client";

import { useState, useTransition } from "react";
import type { UserSettings } from "@/lib/memory/settings";

type Language = "th" | "en" | null;

const LANG_OPTIONS: { value: Language; label: string; sub: string }[] = [
  { value: "th", label: "ภาษาไทย", sub: "Thai" },
  { value: null, label: "Auto", sub: "ตามที่พิมพ์" },
  { value: "en", label: "English", sub: "อังกฤษ" },
];

export default function DashboardClient({
  token,
  initial,
}: {
  token: string;
  initial: UserSettings;
}) {
  const [settings, setSettings] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [isPending, startTransition] = useTransition();

  async function patchSettings(patch: Partial<UserSettings>) {
    setStatus("saving");
    try {
      const res = await fetch(`/api/settings?token=${encodeURIComponent(token)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("save failed");
      const updated = (await res.json()) as UserSettings;
      setSettings(updated);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  }

  function selectLanguage(lang: Language) {
    if (lang === settings.language) return;
    startTransition(() => {
      patchSettings({ language: lang });
    });
  }

  const currentLang = settings.language as Language;

  return (
    <div style={styles.card}>
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>ภาษา / Language</h2>
        <p style={styles.sectionDesc}>
          เลขาจะตอบกลับด้วยภาษาอะไร?
          <br />
          <span style={styles.descEn}>How should Lekha reply to you?</span>
        </p>

        <div style={styles.toggleGroup}>
          {LANG_OPTIONS.map((opt) => {
            const active = opt.value === currentLang;
            return (
              <button
                key={String(opt.value)}
                onClick={() => selectLanguage(opt.value)}
                disabled={isPending || status === "saving"}
                style={{
                  ...styles.toggleBtn,
                  ...(active ? styles.toggleBtnActive : styles.toggleBtnInactive),
                }}
              >
                <span style={styles.btnMain}>{opt.label}</span>
                <span style={styles.btnSub}>{opt.sub}</span>
              </button>
            );
          })}
        </div>

        <p style={styles.statusText}>
          {status === "saving" && "กำลังบันทึก..."}
          {status === "saved" && "✓ บันทึกแล้ว"}
          {status === "error" && "⚠ บันทึกไม่สำเร็จ กรุณาลองใหม่"}
          {status === "idle" && " "}
        </p>
      </div>

      <hr style={styles.divider} />

      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>การตั้งค่าอื่น ๆ / Other Settings</h2>
        <div style={styles.infoRow}>
          <span style={styles.infoLabel}>Timezone</span>
          <span style={styles.infoValue}>{settings.timezone}</span>
        </div>
        {settings.location && (
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>Location</span>
            <span style={styles.infoValue}>{settings.location}</span>
          </div>
        )}
        <div style={styles.infoRow}>
          <span style={styles.infoLabel}>Morning briefing</span>
          <span style={styles.infoValue}>
            {settings.morningBriefingTime
              ? `${settings.morningBriefingTime} (${settings.timezone})`
              : "Off"}
          </span>
        </div>
        <p style={styles.hint}>
          เปลี่ยนการตั้งค่าอื่น ๆ ได้ผ่านการแชทกับเลขาใน LINE
          <br />
          <span style={styles.descEn}>
            Change other settings by chatting with Lekha in LINE.
          </span>
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "#fff",
    borderRadius: 16,
    boxShadow: "0 2px 16px rgba(0,0,0,0.08)",
    overflow: "hidden",
  },
  section: {
    padding: "1.5rem",
  },
  sectionTitle: {
    fontSize: "1rem",
    fontWeight: 700,
    marginBottom: "0.4rem",
    color: "#111",
  },
  sectionDesc: {
    fontSize: "0.88rem",
    color: "#555",
    marginBottom: "1rem",
    lineHeight: 1.6,
  },
  descEn: {
    color: "#888",
    fontSize: "0.83rem",
  },
  toggleGroup: {
    display: "flex",
    gap: 8,
  },
  toggleBtn: {
    flex: 1,
    border: "2px solid transparent",
    borderRadius: 12,
    padding: "0.75rem 0.5rem",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    transition: "all 0.15s",
    fontFamily: "inherit",
  },
  toggleBtnActive: {
    background: "#5856d6",
    borderColor: "#5856d6",
    color: "#fff",
  },
  toggleBtnInactive: {
    background: "#f5f5f7",
    borderColor: "#f5f5f7",
    color: "#333",
  },
  btnMain: {
    fontSize: "0.95rem",
    fontWeight: 600,
  },
  btnSub: {
    fontSize: "0.72rem",
    opacity: 0.75,
  },
  statusText: {
    marginTop: "0.75rem",
    fontSize: "0.82rem",
    color: "#5856d6",
    minHeight: "1.2em",
  },
  divider: {
    border: "none",
    borderTop: "1px solid #f0f0f0",
    margin: 0,
  },
  infoRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.4rem 0",
    borderBottom: "1px solid #f7f7f7",
  },
  infoLabel: {
    fontSize: "0.85rem",
    color: "#666",
  },
  infoValue: {
    fontSize: "0.85rem",
    color: "#111",
    fontWeight: 500,
  },
  hint: {
    marginTop: "1rem",
    fontSize: "0.82rem",
    color: "#888",
    lineHeight: 1.6,
  },
};
