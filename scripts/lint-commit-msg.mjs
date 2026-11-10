#!/usr/bin/env node
// Commit and pull-request-title lint.
//   node scripts/lint-commit-msg.mjs --file <path>        commit-msg hook
//   node scripts/lint-commit-msg.mjs --range <base>..<head>  every commit in a range (CI)
//   node scripts/lint-commit-msg.mjs --title "<text>"     a pull request title (it becomes the squash commit)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TYPES = ["feat", "fix", "docs", "chore", "refactor", "test", "ci", "build", "perf", "style", "revert"];
const HEADER = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9][a-z0-9-]*\\))?!?: \\S.*$`);
const MAX_HEADER = 72;

const FORBIDDEN = [
  [/^\s*(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by)\s*:/im, "trailer"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/, "email address"],
  [/generated (with|by)|assisted (by|with)|written (by|with) (an? )?(ai|llm)/i, "tool or AI disclosure"],
  [/\b(claude|anthropic|chatgpt|openai|copilot|gemini|llm)\b/i, "tool or AI name"],
  [/\bAI[- ](assisted|generated|powered|written)\b/i, "AI disclosure"],
  [/\p{Extended_Pictographic}/u, "emoji"],
];

const SCISSORS = /^# -+ >8 -+$/m;
const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*|BREAKING CHANGE):(\s|$)/;
const ALLOWED_TRAILER_KEYS = new Set(["breaking change", "refs", "fixes", "closes"]);

/** Drops what git adds to the editor template: comment lines and the verbose diff after the scissors line. */
export function stripEditorTemplate(message) {
  const cut = message.search(SCISSORS);
  const kept = cut === -1 ? message : message.slice(0, cut);
  return kept
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n");
}

/**
 * @param {string} message
 * @returns {string[]} problems found in one commit message or title
 */
export function lintMessage(message) {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const header = (lines[0] ?? "").trimEnd();
  const problems = [];
  if (!HEADER.test(header)) {
    problems.push(`header must look like "type(scope): subject" with type one of ${TYPES.join(", ")}`);
  }
  if (header.length > MAX_HEADER) problems.push(`header is ${header.length} characters, limit is ${MAX_HEADER}`);
  if (/[.]$/.test(header)) problems.push("header must not end with a full stop");
  const text = lines.join("\n");
  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(text)) problems.push(`contains a forbidden ${what}`);
  }
  // Any trailer-shaped line in the last paragraph is refused unless its key is on the short allowlist.
  const paragraphs = text.trim().split(/\n\s*\n/);
  if (paragraphs.length > 1) {
    for (const line of (paragraphs.at(-1) ?? "").split("\n")) {
      const key = line.match(TRAILER_LINE) && line.slice(0, line.indexOf(":")).trim().toLowerCase();
      if (key && !ALLOWED_TRAILER_KEYS.has(key)) problems.push(`contains a forbidden trailer (${line.slice(0, line.indexOf(":"))})`);
    }
  }
  return problems;
}

// Commits already on dev whose message cannot be rewritten (dev's history is never rewritten) and that a
// reader would not call a trailer: a squash body that began with the sentence "Perform: number keys, pads...".
// Each entry is the first nine characters of the commit's hash. Nothing else is exempt, and a new commit
// is never added here to get past the rule: the message is changed instead.
const ACCEPTED = new Set(["f5f89e7d0"]);
export const isAccepted = (sha) => ACCEPTED.has(sha.slice(0, 9));

function commitsInRange(range) {
  const raw = execFileSync("git", ["log", "--no-merges", "--format=%H%x00%B%x01", range], { encoding: "utf8" });
  return raw
    .split("\x01")
    .map((chunk) => chunk.replace(/^\n/, ""))
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [sha, message] = chunk.split("\x00");
      return { sha: sha.slice(0, 9), message };
    });
}

function main(argv) {
  const flag = argv[0];
  const value = argv[1];
  /** @type {{label: string, message: string}[]} */
  let items;
  if (flag === "--file" && value) items = [{ label: value, message: stripEditorTemplate(readFileSync(value, "utf8")) }];
  else if (flag === "--title" && value) items = [{ label: "title", message: value }];
  else if (flag === "--range" && value) items = commitsInRange(value).filter((c) => !isAccepted(c.sha)).map((c) => ({ label: c.sha, message: c.message }));
  else {
    console.error("usage: lint-commit-msg.mjs --file <path> | --title <text> | --range <base>..<head>");
    return 2;
  }
  let failed = false;
  for (const { label, message } of items) {
    for (const problem of lintMessage(message)) {
      console.error(`commit lint [${label}]: ${problem}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
