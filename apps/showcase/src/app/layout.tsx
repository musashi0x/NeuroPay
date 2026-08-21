import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "NeuroPay — Try as the agent",
  description:
    "A visitor-facing demo that runs the NeuroPay buyer against the test seller. The browser never sees a session key; the server pays each 402 it receives.",
};

export const viewport: Viewport = {
  themeColor: "#05060A",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
