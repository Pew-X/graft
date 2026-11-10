import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chain } from "./chain.ts";
import { previewOf } from "./preview.ts";
import { apiUrls } from "./server.ts";

const entry = (title: string) =>
  ({ state: "available", title }) as unknown as Chain["stages"][number];

test("the preview is the final stage's title and one plain line", () => {
  const chain: Chain = { stages: [entry("a"), entry("b"), entry("the last one")], truncated: null };
  assert.deepEqual(previewOf(chain), {
    title: "the last one",
    description: "a sound and the 2 flips that came before it, rolled as credits.",
  });
});

test("the line counts correctly for one flip and for a source alone", () => {
  assert.equal(
    previewOf({ stages: [entry("a"), entry("b")], truncated: null }).description,
    "a sound and the 1 flip that came before it, rolled as credits.",
  );
  assert.equal(
    previewOf({ stages: [entry("a")], truncated: null }).description,
    "a sound, with its credits.",
  );
});

test("a final stage that cannot be read gives the site's name, never a made-up title", () => {
  const chain = {
    stages: [entry("a"), { state: "unavailable", id: "x" }],
    truncated: null,
  } as unknown as Chain;
  assert.equal(previewOf(chain).title, "graft");
});

test("the service's address is read at request time, with a default, and trailing slashes go", () => {
  assert.deepEqual(apiUrls({}), {
    server: "http://127.0.0.1:8080",
    browser: "http://127.0.0.1:8080",
  });
  assert.deepEqual(
    apiUrls({
      GRAFT_API_URL: "http://api.internal:9/",
      GRAFT_PUBLIC_API_URL: "https://api.example.test//",
    }),
    { server: "http://api.internal:9", browser: "https://api.example.test" },
  );
});
