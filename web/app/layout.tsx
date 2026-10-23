import type { Metadata, Viewport } from "next";
import {
  Archivo_Black,
  Barlow_Condensed,
  Caveat_Brush,
  Inter_Tight,
  Instrument_Serif,
  JetBrains_Mono,
} from "next/font/google";
import type { ReactNode } from "react";
import { copy } from "../lib/copy.ts";
import { themeInitScript } from "../lib/theme/init.ts";
import { themeCss } from "../lib/theme/tokens.ts";
import "./roll.css";
import "./make.css";

// The locked look's type (all SIL Open Font Licence, self-hosted at build time by next/font).
const sans = Inter_Tight({
  variable: "--f-sans",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});
const serif = Instrument_Serif({
  variable: "--f-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});
const cond = Barlow_Condensed({ variable: "--f-cond", subsets: ["latin"], weight: ["800"] });
const brush = Caveat_Brush({ variable: "--f-brush", subsets: ["latin"], weight: "400" });
const black = Archivo_Black({ variable: "--f-black", subsets: ["latin"], weight: "400" });
const mono = JetBrains_Mono({ variable: "--f-mono", subsets: ["latin"], weight: ["400", "500"] });

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
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sans.variable} ${serif.variable} ${cond.variable} ${brush.variable} ${black.variable} ${mono.variable}`}
    >
      <head>
        <style>{themeCss()}</style>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        {/* the roughening filter that tears the edges of the title slabs */}
        <svg
          width="0"
          height="0"
          style={{ position: "absolute" }}
          aria-hidden="true"
          focusable="false"
        >
          <filter id="rough" x="-5%" y="-10%" width="110%" height="120%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.035"
              numOctaves="2"
              seed="4"
              result="n"
            />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="5" />
          </filter>
        </svg>
        {children}
      </body>
    </html>
  );
}
