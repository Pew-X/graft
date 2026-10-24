#!/usr/bin/env node
// Repository hygiene: only code, scripts, README.md, ARCHITECTURE.md and config are committed;
// no email addresses; no private organisation or AWS account identity; graft vocabulary in prose
// and user-facing copy.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ALLOWED_MARKDOWN = new Set(["README.md", "ARCHITECTURE.md"]);
const PLANNING_DIRS = /(^|\/)(vault|\.claude|\.scratch|docs|\.obsidian)\//i;
const DOCUMENT = /\.(md|mdx|markdown|txt|org|rst|pdf|docx?)$/i;
const PLANNING_NAMES = /^(spec|glossary)[^/]*\.md$|\.local$/i;
const LOCKFILES = /(^|\/)(Cargo\.lock|pnpm-lock\.yaml|package-lock\.json)$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|wasm|pcm|bin|pdf|docx?)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/;
// The builder's other organisation. Written as a repetition so this file does not match itself.
const PRIVATE_ORG = /trel{2}ys/i;
// A real AWS account id, in an ARN or as the console prints it (4-4-4). AWS's documented example
// ids are what tests and docs may use.
const ARN_ACCOUNT = /arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12}):/;
const SPACED_ACCOUNT = /(?<![\w-])\d{4}-\d{4}-\d{4}(?![\w-])/;
const EXAMPLE_ACCOUNTS = new Set(["123456789012", "000000000000"]);
// Words that belong to the audited product or overclaim; never graft vocabulary.
const BANNED = /\b(drop|drops|stack|stacks|take|takes|recipe|recipes|kitchen|chef|verified|proven|certified|owned by|cleared)\b/i;

// The TypeScript port and the browser harness are test support; the UI must never import them.
const WEB_BOUNDARY = /tools\/vectors|graft-vectors-tools/;

/** Files whose prose is user-facing: documentation and the web app's copy. */
const isProse = (path) => ALLOWED_MARKDOWN.has(path) || /^web\/.*\.(tsx?|mdx)$/.test(path) && !/\.(test|spec)\.|\/node_modules\//.test(path);

/**
 * @param {string[]} files tracked paths
 * @param {(path: string) => string} read
 * @returns {string[]} one message per violation
 */
export function checkFiles(files, read) {
  const found = [];
  for (const path of files) {
    if (PLANNING_DIRS.test(path) || PLANNING_NAMES.test(path.split("/").pop() ?? "")) {
      found.push(`${path}: planning artefacts stay local and gitignored`);
      continue;
    }
    if (DOCUMENT.test(path) && !ALLOWED_MARKDOWN.has(path)) {
      found.push(`${path}: only README.md and ARCHITECTURE.md may be committed as documents`);
      continue;
    }
    if (BINARY.test(path)) continue;
    const text = read(path);
    if (PRIVATE_ORG.test(text)) found.push(`${path}: names a private organisation`);
    if (!LOCKFILES.test(path)) {
      const email = text.match(EMAIL);
      if (email) found.push(`${path}: contains an email address (${email[0]})`);
      const arn = text.match(ARN_ACCOUNT);
      if ((arn && !EXAMPLE_ACCOUNTS.has(arn[1])) || SPACED_ACCOUNT.test(text)) {
        found.push(`${path}: contains an AWS account id`);
      }
    }
    if (path.startsWith("web/") && !path.endsWith("pnpm-lock.yaml")) {
      const hit = text.match(WEB_BOUNDARY);
      if (hit) found.push(`${path}: the web app must not reference the test tooling (${hit[0]})`);
    }
    if (isProse(path)) {
      text.split("\n").forEach((line, i) => {
        const word = line.match(BANNED);
        if (word) found.push(`${path}:${i + 1}: "${word[0]}" is not graft vocabulary`);
      });
    }
  }
  return found;
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const found = checkFiles(files, (p) => readFileSync(p, "utf8"));
  for (const line of found) console.error(`repo check: ${line}`);
  if (found.length > 0) process.exit(1);
  console.log(`repo check: ok (${files.length} tracked files)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
