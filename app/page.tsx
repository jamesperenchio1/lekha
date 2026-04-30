export default function HomePage() {
  return (
    <main
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: 540,
        margin: "10vh auto",
        padding: "2rem",
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ fontSize: "1.5rem" }}>Lekha</h1>
      <p>A personal AI assistant that lives in LINE.</p>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        This is a backend. Add the LINE Official Account from your phone to chat with the bot.
      </p>
    </main>
  );
}
