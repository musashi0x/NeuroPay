import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "NeuroPay — Agents buy the services they need",
  description:
    "A catalog of paid APIs and the gateway that handles payment for them. Every listing carries a price per call: the gateway issues HTTP 402, checks the request against the owner's grant, and settles the configured payment token on BNB Chain before the call runs.",
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
