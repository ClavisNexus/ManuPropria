#!/usr/bin/env node
// Checks that what this public repository shows says nothing it should not: secrets, personal
// contact details, paths on someone's machine, and references to files readers cannot open.
// The same file is in every public repository of ClavisNexus; change them together.
//
//   node .github/public-surface.mjs            the files git tracks here
//   node .github/public-surface.mjs --dir <d>  every file under <d>, such as an unpacked npm package;
//                                              its references may also name files tracked here
//
// .github/public-surface.json (optional):
//   "skip"        path prefixes that are not read (third-party texts, test vectors)
//   "allowRefs"   references to files outside this repository that may stay
//   "allowEmails" addresses, or "@domain", besides the ones below
// Findings print where they are; emails, phone numbers and secrets are not repeated in the log.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dirMode = args[0] === "--dir";
if (dirMode && !args[1]) {
  console.error("usage: public-surface.mjs [--dir <directory>]");
  process.exit(2);
}
const base = dirMode ? resolve(args[1]) : root;

const configPath = join(root, ".github", "public-surface.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const skip = config.skip ?? [];
const allowRefs = new Set(config.allowRefs ?? []);
const allowEmails = (config.allowEmails ?? []).map((e) => e.toLowerCase());

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const files = dirMode ? walk(base) : tracked;
// A package may point at files of the repository it is published from.
const known = new Set([...files, ...tracked]);

const SECRETS = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, "private key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "npm token"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, "GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\bsk_live_[A-Za-z0-9]{20,}\b/, "Stripe key"],
];
const SECRET_FILES = /(^|\/)(\.env(\.(?!example$|sample$)[^/]*)?|id_rsa|id_ed25519|[^/]+\.(pem|p12|pfx|key))$/;
const LOCAL_PATHS = /(?:\/Users\/[^/\s"'`]+\/|\/home\/(?!runner\/)[^/\s"'`]+\/|\b[A-Za-z]:\\{1,2}Users\\{1,2})/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const EMAIL_DOMAINS = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost|users\.noreply\.github\.com|clavis\.nexus|deepdive\.sh)$/i;
const PHONE = /(?<![\w-])(?:0[5789]0-\d{4}-\d{4}|\+81[- ]?\d{1,4}[- ]\d{1,4}[- ]\d{4})(?![\w-])/;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]"'`]+/gi;
const MD_REF = /(?<![\w/.@~$}-])((?:\.\.?\/)*(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.md)(?![\w-])/g;
const SECTION_REF = /(?<![\w/.-])([A-Za-z][\w.-]*[A-Za-z])\s?§/g;
const DOC_NAME = /[A-Z._-]/;
const CODE_REF = /(?<![\w/.@~$}-])((?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.(?:mts|cts|ts|tsx|mjs|cjs|rs|go|sh|py))(?![\w-])/g;
const BUILD_DIRS = new Set(["dist", "out", "build", "target", "node_modules"]);
const COMMON_NAMES = /^(LICEN[CS]E|COPYING|README|CHANGELOG|CONTRIBUTING|SECURITY|NOTICE|CODE_OF_CONDUCT)([.-][\w.-]*)?\.md$/i;

function resolves(ref, file) {
  if (allowRefs.has(ref) || COMMON_NAMES.test(ref)) return true;
  const clean = ref.replace(/^(\.\.?\/)+/, "");
  const candidates = [posix.normalize(posix.join(posix.dirname(file), ref)), posix.normalize(ref), clean];
  if (candidates.some((c) => known.has(c) || isDir(c))) return true;
  for (const f of known) if (f.endsWith(`/${clean}`)) return true;
  return false;
}

function isDir(p) {
  return [base, root].some((b) => {
    try {
      return statSync(join(b, p)).isDirectory();
    } catch {
      return false;
    }
  });
}

function emailAllowed(address) {
  const a = address.toLowerCase();
  const domain = a.slice(a.lastIndexOf("@") + 1);
  if (/^\d+\./.test(domain)) return true;
  return EMAIL_DOMAINS.test(domain) || allowEmails.includes(a) || allowEmails.includes(`@${domain}`);
}

const findings = [];
const report = (file, line, kind, shown) => findings.push(`${file}:${line}: ${kind}${shown ? `: ${shown}` : ""}`);

for (const file of files) {
  if (skip.some((s) => file === s || file.startsWith(s.endsWith("/") ? s : `${s}/`))) continue;
  if (SECRET_FILES.test(file)) report(file, 0, "file that usually holds a secret");
  let buf;
  try {
    buf = readFileSync(join(base, file));
  } catch {
    continue;
  }
  if (buf.subarray(0, 8000).includes(0)) continue;
  const lines = buf.toString("utf8").split("\n");
  lines.forEach((text, i) => {
    const n = i + 1;
    for (const [re, kind] of SECRETS) if (re.test(text)) report(file, n, kind);
    const local = text.match(LOCAL_PATHS);
    if (local) report(file, n, "path on a machine", local[0]);
    for (const m of text.matchAll(EMAIL)) if (!emailAllowed(m[0])) report(file, n, "email address");
    if (PHONE.test(text)) report(file, n, "phone number");
    const prose = text.replace(URL, " ");
    for (const m of prose.matchAll(MD_REF)) if (!resolves(m[1], file)) report(file, n, "reference to a file not here", m[1]);
    for (const m of prose.matchAll(SECTION_REF)) {
      const name = m[1];
      if (/^RFC$/i.test(name) || name.endsWith(".md") || !DOC_NAME.test(name)) continue;
      if (!resolves(`${name}.md`, file) && !resolves(name, file)) report(file, n, "section of a document not here", `${name} §`);
    }
    for (const m of prose.matchAll(CODE_REF)) {
      if (BUILD_DIRS.has(m[1].split("/")[0])) continue;
      if (!resolves(m[1], file)) report(file, n, "reference to a file not here", m[1]);
    }
  });
}

if (findings.length) {
  console.log(findings.join("\n"));
  console.log(`\n${findings.length} finding(s). What may and may not be public: ClavisNexus docs/engineering/public-surfaces.md.`);
  process.exit(1);
}
console.log(`public-surface: ${files.length} files, nothing found.`);
