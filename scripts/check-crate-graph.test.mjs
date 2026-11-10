import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED, EXTERNAL_ONLY, violations } from "./check-crate-graph.mjs";

const pkg = (name, ...deps) => ({
  name,
  dependencies: deps.map((d) => (typeof d === "string" ? { name: d, kind: null } : d)),
});
const clean = () => Object.keys(ALLOWED).map((n) => pkg(n, ...(ALLOWED[n] ?? [])));
const replace = (pkgs, next) => pkgs.map((p) => (p.name === next.name ? next : p));

test("the allowed map itself passes", () => {
  assert.deepEqual(violations(clean()), []);
});

test("domain depending on storage is rejected (the centre depends on nothing in the workspace)", () => {
  const pkgs = replace(clean(), pkg("graft-domain", "graft-storage"));
  assert.match(violations(pkgs).join("\n"), /graft-domain: may not depend on graft-storage/);
});

test("a dev-dependency edge against the arrow is rejected too", () => {
  const pkgs = replace(clean(), pkg("graft-storage", "graft-domain", { name: "graft-api", kind: "dev" }));
  assert.match(violations(pkgs).join("\n"), /graft-storage: may not depend on graft-api \(dev\)/);
});

test("render takes no dependency at all, not even an external one", () => {
  const pkgs = replace(clean(), pkg("graft-render", "serde"));
  assert.match(violations(pkgs).join("\n"), /graft-render: must have no dependencies, found serde/);
});

test("nothing may depend on api", () => {
  const pkgs = replace(clean(), pkg("graft-events", "graft-domain", "graft-api"));
  assert.match(violations(pkgs).join("\n"), /graft-events: may not depend on graft-api/);
});

test("a crate missing from the map is reported so the map cannot rot", () => {
  assert.match(violations([...clean(), pkg("graft-new")]).join("\n"), /graft-new: not in the crate map/);
});

test("the render host may use only its allowlisted external crates (no network surface)", () => {
  const withExternal = (...names) =>
    replace(clean(), pkg("graft-render-host", "graft-domain", ...names));
  assert.deepEqual(violations(withExternal(...EXTERNAL_ONLY["graft-render-host"])), []);
  assert.match(
    violations(withExternal("hyper")).join("\n"),
    /graft-render-host: external dependency hyper is not on its allowlist/,
  );
  assert.match(
    violations(withExternal("tokio")).join("\n"),
    /external dependency tokio is not on its allowlist/,
  );
});
