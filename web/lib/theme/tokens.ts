/**
 * The design tokens, defined once. The stylesheet is generated from them (`themeCss`) and the contrast
 * test reads the same values, so what is checked is what is shipped. Light is a gallery wall, dark is
 * leader black; both follow the system unless the visitor picks one. The four dyes are shared by the
 * title slab and, later, the record band. Ticket 25 refines the pixels; the structure stays.
 */

export interface Theme {
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  /** Borders of controls. */
  line: string;
  focus: string;
  /** A hairline between credit lines (decoration: it carries no meaning). */
  hair: string;
  /** How strong the paper grain is, 0 to 1 (decoration, removable). */
  grain: string;
}

export const light: Theme = {
  bg: "#efebe3",
  surface: "#f7f4ee",
  ink: "#14110e",
  muted: "#5a5247",
  line: "#6b6359",
  focus: "#0b6b3a",
  hair: "rgba(21,20,19,.14)",
  grain: "0.5",
};

export const dark: Theme = {
  bg: "#0c0b0a",
  surface: "#171513",
  ink: "#efebe3",
  muted: "#a79f93",
  line: "#7d766c",
  focus: "#5dff9c",
  hair: "rgba(236,230,216,.14)",
  grain: "0",
};

export const themes = { light, dark } as const;

export interface Dye {
  name: string;
  fill: string;
  /** The colour of text set on the dye. */
  text: string;
}

export const dyes: readonly Dye[] = [
  { name: "red", fill: "#d2342a", text: "#ffffff" },
  { name: "teal", fill: "#1e8c84", text: "#0c0b0a" },
  { name: "gold", fill: "#e0a526", text: "#14110e" },
  { name: "magenta", fill: "#c2307a", text: "#ffffff" },
];

function channel(hex: string, from: number): number {
  const v = parseInt(hex.slice(from, from + 2), 16) / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of an sRGB colour written `#rrggbb`. */
function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** The WCAG contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const vars = (theme: Theme): string =>
  Object.entries(theme)
    .map(([key, value]) => `--${key}:${value};`)
    .join("");

const dyeVars = dyes
  .map((dye, i) => `--dye-${i}:${dye.fill};--dye-${i}-text:${dye.text};`)
  .join("");

/** The stylesheet for both themes: the system preference, then the visitor's explicit choice. */
export function themeCss(): string {
  return [
    `:root{color-scheme:light;${vars(light)}${dyeVars}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;${vars(dark)}}}`,
    `:root[data-theme="dark"]{color-scheme:dark;${vars(dark)}}`,
    `:root[data-theme="light"]{color-scheme:light;${vars(light)}}`,
  ].join("\n");
}
