#!/usr/bin/env node
// Repository hygiene: only code, scripts, README.md, USER-MANUAL.md, ARCHITECTURE.md, SECURITY.md and config are committed;
// no email addresses; no AWS account id; none of the author's own private patterns (see below); graft
// vocabulary in prose and user-facing copy.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ALLOWED_MARKDOWN = new Set(["README.md", "USER-MANUAL.md", "ARCHITECTURE.md", "SECURITY.md"]);
const PLANNING_DIRS = /(^|\/)(vault|\.claude|\.scratch|docs|\.obsidian)\//i;
const DOCUMENT = /\.(md|mdx|markdown|txt|org|rst|pdf|docx?)$/i;
const PLANNING_NAMES = /^(spec|glossary)[^/]*\.md$|\.local$/i;
const LOCKFILES = /(^|\/)(Cargo\.lock|pnpm-lock\.yaml|package-lock\.json)$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|wasm|pcm|bin|pdf|docx?)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/;
// Patterns the author never wants committed (an employer, a client, a private handle). They are NOT in
// the repository: a pattern written here would be the leak. They live one per line in `.private-patterns`
// (gitignored; `#` starts a comment; each line is a case-insensitive regular expression) or in the file
// named by GRAFT_PRIVATE_PATTERNS. Without that file the check simply has nothing extra to look for.
const PRIVATE_PATTERNS_FILE = ".private-patterns";

/** @param {string} [file] @returns {RegExp[]} */
export function loadPrivatePatterns(file = process.env["GRAFT_PRIVATE_PATTERNS"] ?? PRIVATE_PATTERNS_FILE) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => new RegExp(l, "i"));
}
// A real AWS account id, in an ARN or as the console prints it (4-4-4). AWS's documented example
// ids are what tests and docs may use.
const ARN_ACCOUNT = /arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12}):/;
const REGISTRY_ACCOUNT = /(?<![\d-])(\d{12})\.dkr\.ecr/;
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
 * @param {RegExp[]} [privatePatterns] what must never appear (see loadPrivatePatterns)
 * @returns {string[]} one message per violation
 */
export function checkFiles(files, read, privatePatterns = []) {
  const found = [];
  for (const path of files) {
    if (PLANNING_DIRS.test(path) || PLANNING_NAMES.test(path.split("/").pop() ?? "")) {
      found.push(`${path}: planning artefacts stay local and gitignored`);
      continue;
    }
    if (DOCUMENT.test(path) && !ALLOWED_MARKDOWN.has(path)) {
      found.push(`${path}: only README.md, USER-MANUAL.md, ARCHITECTURE.md and SECURITY.md may be committed as documents`);
      continue;
    }
    if (BINARY.test(path)) continue;
    const text = read(path);
    if (privatePatterns.some((re) => re.test(text))) found.push(`${path}: matches a private pattern`);
    if (!LOCKFILES.test(path)) {
      const email = text.match(EMAIL);
      if (email) found.push(`${path}: contains an email address (${email[0]})`);
      const arn = text.match(ARN_ACCOUNT);
      const registry = text.match(REGISTRY_ACCOUNT);
      if (
        (arn && !EXAMPLE_ACCOUNTS.has(arn[1])) ||
        (registry && !EXAMPLE_ACCOUNTS.has(registry[1])) ||
        SPACED_ACCOUNT.test(text)
      ) {
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
  const found = checkFiles(files, (p) => readFileSync(p, "utf8"), loadPrivatePatterns());
  for (const line of found) console.error(`repo check: ${line}`);
  if (found.length > 0) process.exit(1);
  console.log(`repo check: ok (${files.length} tracked files)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
