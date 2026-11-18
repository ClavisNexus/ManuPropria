#!/usr/bin/env node
// Fails on every high or critical advisory `pnpm audit` reports, like `pnpm audit --audit-level high`,
// except an advisory with no fixed release that scripts/audit-exceptions.json covers (README, Dependency audit).
// Kept in step with ClavisSDK's scripts/audit-security.mjs.
//
//   node scripts/audit-security.mjs
//
// - The dependencies the published packages carry (`pnpm audit --prod`) take no exception: any high
//   or critical advisory there fails.
// - A high or critical advisory in the whole tree (`pnpm audit`) passes only when an exception
//   - has the same advisory ID and package, and names every version found
//   - has not passed its last day (`until`, a UTC date, at most 30 days after `decided`)
//   - and the advisory has no fixed release (`patched_versions` is `<0.0.0`). Once a fix is published,
//     it still passes until the fix is minimumReleaseAge (pnpm-workspace.yaml) old, then fails so the
//     lockfile is updated.
// - An exception that no high or critical advisory matches fails too, so it is not left behind.
// - An audit or registry response that cannot be read fails.
// CI runs it before install, so it loads no dependency.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXCEPTIONS_FILE = "scripts/audit-exceptions.json";
const FAILING = new Set(["high", "critical"]);
const MAX_EXCEPTION_DAYS = 30;
const DAY_MS = 86_400_000;
const NO_PATCH = "<0.0.0";
const EXACT = /^(\d+)\.(\d+)\.(\d+)$/;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * @typedef {{ id: string, package: string, versions: string[], reason: string, decided: string, until: string }} AuditException
 * @typedef {{ github_advisory_id: string, module_name: string, severity: string, vulnerable_versions: string,
 *   patched_versions: string, title?: string, url?: string, findings: { version: string, paths: string[] }[] }} Advisory
 * @typedef {{ advisories?: Record<string, Advisory>, error?: { code?: string, message?: string } }} AuditReport
 * @typedef {(name: string) => Promise<{ time?: Record<string, string> }>} FetchPackument
 */

/** @param {string} v */
function parseExact(v) {
  const m = EXACT.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** @param {number[]} a @param {number[]} b */
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** @param {unknown} day */
function parseDay(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== day ? null : t;
}

/** @param {number} t */
function isoDay(t) {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Checks the shape of one exception.
 * @param {unknown} e
 * @returns {string | null} why it is malformed, or null
 */
export function invalidException(e) {
  if (!e || typeof e !== "object") return "not an object";
  const x = /** @type {Record<string, unknown>} */ (e);
  if (typeof x.id !== "string" || !/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(x.id)) return "id is not a GHSA ID";
  if (typeof x.package !== "string" || x.package === "") return "package is missing";
  if (!Array.isArray(x.versions) || x.versions.length === 0 || !x.versions.every((v) => typeof v === "string" && EXACT.test(v))) {
    return "versions is not a list of exact versions";
  }
  if (typeof x.reason !== "string" || x.reason.trim() === "") return "reason is missing";
  const decided = parseDay(x.decided);
  const until = parseDay(x.until);
  if (decided === null || until === null) return "decided or until is not a YYYY-MM-DD date";
  if (until < decided || until - decided > MAX_EXCEPTION_DAYS * DAY_MS) {
    return `until is not within ${MAX_EXCEPTION_DAYS} days after decided`;
  }
  return null;
}

/**
 * Decides from the registry's publish times whether the fix can be installed yet.
 * @param {{ advisory: Advisory, now: number, minReleaseAgeDays: number, fetchPackument: FetchPackument }} input
 * @returns {Promise<{ ok: true, note: string } | { ok: false, reason: string }>}
 */
async function judgePatch({ advisory, now, minReleaseAgeDays, fetchPackument }) {
  const range = /^>=\s*(\d+\.\d+\.\d+)$/.exec(advisory.patched_versions.trim());
  const floor = range ? parseExact(range[1]) : null;
  if (!floor) return { ok: false, reason: `cannot read the patched range ${advisory.patched_versions}` };
  /** @type {{ time?: Record<string, string> }} */
  let doc;
  try {
    doc = await fetchPackument(advisory.module_name);
  } catch (err) {
    return { ok: false, reason: `cannot read ${advisory.module_name} from the registry (${err instanceof Error ? err.message : err})` };
  }
  const published = Object.entries(doc.time ?? {})
    .map(([v, at]) => ({ v, parsed: parseExact(v), at: Date.parse(at) }))
    .filter((x) => x.parsed && compare(x.parsed, floor) >= 0 && !Number.isNaN(x.at))
    .sort((a, b) => a.at - b.at);
  if (published.length === 0) {
    return { ok: false, reason: `the registry has no version in the patched range ${advisory.patched_versions}` };
  }
  const first = published[0];
  const installableAt = first.at + minReleaseAgeDays * DAY_MS;
  if (installableAt <= now) {
    return {
      ok: false,
      reason: `the fix ${first.v} (published ${isoDay(first.at)}) is past the release age; update the lockfile and drop the exception`,
    };
  }
  return { ok: true, note: `the fix ${first.v} (published ${isoDay(first.at)}) can be installed from ${isoDay(installableAt)}` };
}

/**
 * @param {{ report: AuditReport, prodReport: AuditReport, exceptions: unknown[], now: number,
 *   minReleaseAgeDays: number, fetchPackument: FetchPackument }} input
 * @returns {Promise<{ failures: string[], excepted: string[] }>}
 */
export async function judgeAudit({ report, prodReport, exceptions, now, minReleaseAgeDays, fetchPackument }) {
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const excepted = [];
  for (const [label, r] of /** @type {[string, AuditReport][]} */ ([["pnpm audit --prod", prodReport], ["pnpm audit", report]])) {
    if (!r || typeof r !== "object" || r.error || !r.advisories) {
      failures.push(`cannot read the result of ${label}${r?.error ? ` (${r.error.code ?? ""} ${r.error.message ?? ""})` : ""}`);
    }
  }
  if (failures.length) return { failures, excepted };

  const describe = (/** @type {Advisory} */ a) =>
    `${a.github_advisory_id} ${a.module_name} ${a.severity} (${a.vulnerable_versions})${a.title ? ` ${a.title}` : ""}`;

  for (const a of Object.values(prodReport.advisories ?? {})) {
    if (FAILING.has(a.severity)) failures.push(`${describe(a)} in the published dependencies, which take no exception`);
  }

  /** @type {Map<string, AuditException>} */
  const byId = new Map();
  for (const [i, e] of exceptions.entries()) {
    const bad = invalidException(e);
    if (bad) {
      failures.push(`${EXCEPTIONS_FILE} entry ${i}: ${bad}`);
      continue;
    }
    const x = /** @type {AuditException} */ (e);
    if (byId.has(x.id)) failures.push(`${EXCEPTIONS_FILE}: ${x.id} appears twice`);
    byId.set(x.id, x);
  }

  /** @type {Set<string>} */
  const used = new Set();
  for (const a of Object.values(report.advisories ?? {})) {
    if (!FAILING.has(a.severity)) continue;
    const e = byId.get(a.github_advisory_id);
    if (!e) {
      failures.push(`${describe(a)}\n  paths: ${a.findings.flatMap((f) => f.paths).slice(0, 5).join(", ")}`);
      continue;
    }
    used.add(e.id);
    if (e.package !== a.module_name) {
      failures.push(`${e.id}: the exception names ${e.package}, the advisory ${a.module_name}`);
      continue;
    }
    const until = /** @type {number} */ (parseDay(e.until));
    if (now >= until + DAY_MS) {
      failures.push(`${e.id}: the exception ended on ${e.until}; read the advisory again, then drop or extend it`);
      continue;
    }
    const outside = a.findings.map((f) => f.version).filter((v) => !e.versions.includes(v));
    if (outside.length) {
      failures.push(`${e.id}: found ${[...new Set(outside)].join(", ")}, which the exception does not name`);
      continue;
    }
    if (a.patched_versions.trim() === NO_PATCH) {
      excepted.push(`${describe(a)}: no fixed release; the exception lasts until ${e.until}`);
      continue;
    }
    const patch = await judgePatch({ advisory: a, now, minReleaseAgeDays, fetchPackument });
    if (patch.ok) excepted.push(`${describe(a)}: ${patch.note}; the exception lasts until ${e.until}`);
    else failures.push(`${e.id}: ${patch.reason}`);
  }

  for (const id of byId.keys()) {
    if (!used.has(id)) failures.push(`${EXCEPTIONS_FILE}: no high or critical advisory matches ${id}; drop the exception`);
  }
  return { failures, excepted };
}

/** @param {string | null} workspaceText */
export function minReleaseAgeDaysFrom(workspaceText) {
  const minutes = workspaceText?.match(/^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/m);
  return minutes ? Number(minutes[1]) / (24 * 60) : 7;
}

/** @param {string[]} args @returns {AuditReport} */
function runAudit(args) {
  const execPath = process.env.npm_execpath;
  const full = ["audit", "--json", ...args];
  const opts = /** @type {const} */ ({ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let r = execPath ? spawnSync(process.execPath, [execPath, ...full], opts) : spawnSync("pnpm", full, opts);
  if (!execPath && r.error && /** @type {NodeJS.ErrnoException} */ (r.error).code === "ENOENT") {
    r = spawnSync("corepack", ["pnpm", ...full], opts);
  }
  if (r.error) return { error: { code: "spawn", message: r.error.message } };
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: { code: "parse", message: (r.stderr || r.stdout || "").trim().slice(0, 500) } };
  }
}

/** @type {FetchPackument} */
async function fetchPackument(name) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name).replace("%40", "@")}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  /** @type {unknown[]} */
  let exceptions;
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, EXCEPTIONS_FILE), "utf8"));
    if (!Array.isArray(doc.exceptions)) throw new Error("exceptions is not a list");
    exceptions = doc.exceptions;
  } catch (err) {
    console.error(`cannot read ${EXCEPTIONS_FILE}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  let workspaceText = null;
  try {
    workspaceText = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  } catch {}
  const { failures, excepted } = await judgeAudit({
    prodReport: runAudit(["--prod"]),
    report: runAudit([]),
    exceptions,
    now: Date.now(),
    minReleaseAgeDays: minReleaseAgeDaysFrom(workspaceText),
    fetchPackument,
  });
  for (const line of excepted) console.log(`excepted: ${line}`);
  if (failures.length) {
    console.error("high or critical advisories (README, Dependency audit):");
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log("no high or critical advisory, apart from the exceptions above");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
