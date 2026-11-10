// The same card for the other crawlers: one picture, drawn once.
export { default, alt, size, contentType } from "./opengraph-image.tsx";

// Not re-exported: Next reads this setting from the file itself.
export const dynamic = "force-dynamic";
