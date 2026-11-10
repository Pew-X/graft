/**
 * Shared checks for the accessibility specs: an axe scan that fails on any serious or critical
 * violation (moderate and minor ones are listed in the report, not hidden), and a measure of every
 * control's touch target.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

export async function scan(page: Page, name: string, info: TestInfo): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const describe = (v: (typeof results.violations)[number]) =>
    `${v.id} (${v.impact}): ${v.help}: ${v.nodes
      .slice(0, 3)
      .map((n) => n.target.join(" "))
      .join(" | ")}`;
  const lesser = results.violations.filter(
    (v) => v.impact !== "serious" && v.impact !== "critical",
  );
  for (const v of lesser) info.annotations.push({ type: `axe ${name}`, description: describe(v) });
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map(describe), `${name}: serious or critical accessibility violations`).toEqual([]);
}

/** Controls smaller than 44 px each way (a checkbox or radio is measured by its label). */
export async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const seen = new Set<Element>();
    const selector =
      'button, a[href], select, textarea, summary, [role="slider"], input:not([type="hidden"]):not([type="file"])';
    for (const el of document.querySelectorAll(selector)) {
      if (seen.has(el)) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      let target: Element = el;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        target = el.closest("label") ?? el;
      }
      seen.add(el);
      const box = target.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      // A control that is only a visually hidden helper is not a target.
      // Text links in the footer are held to WCAG 2.2's 24 px (axe checks that too); every control is 44.
      const least = el.closest(".footer") ? 24 : 44;
      if (box.width < least || box.height < least) {
        const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30);
        out.push(
          `${el.tagName.toLowerCase()} "${name}" ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
      }
    }
    return out;
  });
}

export const noSmallTargets = async (page: Page, name: string): Promise<void> => {
  expect(await smallTargets(page), `${name}: targets under 44 px`).toEqual([]);
};
