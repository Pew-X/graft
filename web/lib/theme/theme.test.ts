// WCAG 2.x contrast, worked from the definition: relative luminance of sRGB, then (L1 + 0.05) / (L2 + 0.05).
// The thresholds are the AA ones: 4.5 for text, 3 for the borders and focus rings that identify controls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { contrast, dyes, themeCss, themes } from "./tokens.ts";

test("the contrast function agrees with the published extremes", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(contrast("#777777", "#ffffff").toFixed(2), "4.48"); // the classic just-under-AA grey
  assert.equal(contrast("#767676", "#ffffff").toFixed(2), "4.54"); // and the grey just over it
});

for (const [name, theme] of Object.entries(themes)) {
  test(`${name}: text on the page meets AA (4.5)`, () => {
    for (const key of ["ink", "muted"] as const) {
      const ratio = contrast(theme[key], theme.bg);
      assert.ok(ratio >= 4.5, `${key} on bg is ${ratio.toFixed(2)}`);
      const onSurface = contrast(theme[key], theme.surface);
      assert.ok(onSurface >= 4.5, `${key} on surface is ${onSurface.toFixed(2)}`);
    }
  });

  test(`${name}: the focus ring and control borders meet 3:1 against the page`, () => {
    assert.ok(contrast(theme.focus, theme.bg) >= 3, "focus ring");
    assert.ok(contrast(theme.line, theme.bg) >= 3, "border");
  });
}

test("text on every dye slab meets AA in both themes", () => {
  for (const [i, dye] of dyes.entries()) {
    const ratio = contrast(dye.text, dye.fill);
    assert.ok(ratio >= 4.5, `dye ${i} (${dye.name}) text is ${ratio.toFixed(2)}`);
  }
});

test("both themes are emitted: the system preference, and the toggle that overrides it", () => {
  const css = themeCss();
  assert.match(css, /:root\s*\{/);
  assert.match(
    css,
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/,
  );
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /:root\[data-theme="light"\]/);
  for (const dye of dyes) assert.ok(css.includes(dye.fill), `${dye.name} is defined`);
});
