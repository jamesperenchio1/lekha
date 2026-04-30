import type { ReactNode } from "react";

export const metadata = {
  title: "Lekha",
  description: "A personal assistant on LINE.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
