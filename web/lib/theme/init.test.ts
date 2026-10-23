import assert from "node:assert/strict";
import { test } from "node:test";
import { THEME_KEY, themeInitScript } from "./init.ts";

/** Run the script against a fake page and report the theme it set, if any. */
function run(stored: string | null | "throws"): string | null {
  let set: string | null = null;
  const localStorage = {
    getItem(key: string) {
      assert.equal(key, THEME_KEY);
      if (stored === "throws") throw new Error("storage blocked");
      return stored;
    },
  };
  const document = {
    documentElement: {
      setAttribute(name: string, value: string) {
        assert.equal(name, "data-theme");
        set = value;
      },
    },
  };
  new Function("localStorage", "document", themeInitScript)(localStorage, document);
  return set;
}

test("a saved light or dark choice is applied before the page is painted", () => {
  assert.equal(run("light"), "light");
  assert.equal(run("dark"), "dark");
});

test("nothing saved, something else saved, or storage blocked: the system's theme stands", () => {
  assert.equal(run(null), null);
  assert.equal(run("purple"), null);
  assert.equal(run("system"), null);
  assert.equal(run("throws"), null);
});
