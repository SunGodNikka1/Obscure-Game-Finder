import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Obscure Game Finder",
  description:
    "A Roblox archaeology terminal: resolve a username, crawl the public social graph and surface forgotten experiences.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="ogf-backdrop" aria-hidden />
        <div className="ogf-grain" aria-hidden />
        <div className="ogf-scanlines" aria-hidden />
        <div className="ogf-vignette" aria-hidden />
        {children}
      </body>
    </html>
  );
}
