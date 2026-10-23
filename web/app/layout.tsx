import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { copy } from "../lib/copy.ts";
import { themeInitScript } from "../lib/theme/init.ts";
import { themeCss } from "../lib/theme/tokens.ts";
import "./roll.css";

export const metadata: Metadata = {
  title: copy.site.name,
  description: copy.site.description,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <style>{themeCss()}</style>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
