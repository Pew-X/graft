// The share card against the real service: a flip's picture is drawn from its real chain, and a flip the
// operator has hidden gets the site's own words, not its title. Each test names the guarantee it protects.
import { expect, test } from "@playwright/test";
import { SEEDED_LAST, hide, publishFlip } from "./service.ts";

function dimensions(png: Buffer): { png: boolean; width: number; height: number } {
  const signature = png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { png: signature, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test("a published flip has a card, drawn from its chain", async ({ request }) => {
  const flip = await publishFlip(request, SEEDED_LAST, "a flip with a card");
  const response = await request.get(`/p/${flip.id}/opengraph-image`);
  expect(response.status()).toBe(200);
  expect(dimensions(await response.body())).toEqual({ png: true, width: 1200, height: 630 });
});

test("a flip hidden by the operator draws the site's own card, which differs from the one it had", async ({
  request,
}) => {
  const flip = await publishFlip(request, SEEDED_LAST, "a flip to hide");
  const before = await (await request.get(`/p/${flip.id}/opengraph-image`)).body();
  await hide(request, flip.id, "withdrawn");
  const after = await request.get(`/p/${flip.id}/opengraph-image`);
  expect(after.status()).toBe(200);
  const body = await after.body();
  expect(dimensions(body).png).toBe(true);
  expect(body.equals(before), "the hidden flip's title is no longer on its card").toBe(false);
});
