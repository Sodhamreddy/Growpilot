import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GrowPilot — AI SEO & Content Automation",
  description: "An AI-powered growth workspace for SEO, content and brand voice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
