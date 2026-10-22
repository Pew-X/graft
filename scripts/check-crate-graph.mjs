#!/usr/bin/env node
// Fails when a workspace crate depends against the allowed direction (ARCHITECTURE.md, "Module boundaries").
// An edge counts whatever its kind: normal, dev or build.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Allowed workspace dependencies per crate. `null` means no dependency of any kind, even external. */
export const ALLOWED = {
  "graft-domain": [],
  "graft-render": null,
  "graft-storage": ["graft-domain"],
  "graft-render-host": ["graft-domain"],
  "graft-events": ["graft-domain"],
  "graft-api": ["graft-domain", "graft-storage", "graft-render-host", "graft-events"],
};

/** @returns {string[]} one message per violation */
export function violations(packages, allowed = ALLOWED) {
  const known = new Set(Object.keys(allowed));
  const found = [];
  for (const pkg of packages) {
    if (!known.has(pkg.name)) {
      found.push(`${pkg.name}: not in the crate map; add it to scripts/check-crate-graph.mjs and ARCHITECTURE.md`);
      continue;
    }
    const rule = allowed[pkg.name];
    for (const dep of pkg.dependencies) {
      if (rule === null) {
        found.push(`${pkg.name}: must have no dependencies, found ${dep.name}`);
      } else if (known.has(dep.name) && !rule.includes(dep.name)) {
        found.push(`${pkg.name}: may not depend on ${dep.name} (${dep.kind ?? "normal"})`);
      }
    }
  }
  for (const name of known) {
    if (!packages.some((p) => p.name === name)) {
      found.push(`${name}: listed in the crate map but missing from the workspace`);
    }
  }
  return found;
}

function main() {
  const raw = execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const found = violations(JSON.parse(raw).packages);
  if (found.length > 0) {
    for (const line of found) console.error(`crate graph: ${line}`);
    process.exit(1);
  }
  console.log("crate graph: ok");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
