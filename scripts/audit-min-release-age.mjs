#!/usr/bin/env node
// Checks that every registry package in pnpm-lock.yaml was published at least minimumReleaseAge
// ago. pnpm install --frozen-lockfile does not re-evaluate minimumReleaseAge, so CI runs this as
// the second check. Kept in step with Nexus's scripts/audit-min-release-age.mjs.
//
//   node scripts/audit-min-release-age.mjs [--days 7] [--json] [--allow-unknown]
//
// Reads pnpm-lock.yaml, pnpm-workspace.yaml and .npmrc of this repository, and the lockfile and
// registry settings as pnpm itself reads them (`pnpm ls --lockfile-only`, `pnpm config list`;
// the pnpmfile is not loaded); no install needed.
// Fails on: a violation not covered by an exact-version minimumReleaseAgeExclude entry, a package
// the registry does not have, a lockfile integrity the registry does not publish, a registry other
// than registry.npmjs.org that the lockfile depends on, a package pnpm would fetch from anything
// but its registry.npmjs.org tarball, pnpm and this script's parser disagreeing on the packages,
// and any lockfile entry or line that is not a registry package or a workspace directory in the
// shape pnpm writes. A transient unknown publish time fails too, unless --allow-unknown is given.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NPM_REGISTRY_HOST = "registry.npmjs.org";
const EXACT_SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** @typedef {{ name: string, version: string, integrity: string | null, paths: string[] }} LockPackageRef */
/** @typedef {{ kind: string, name?: string, version?: string, detail?: string }} LockEntryNote */

const LOCK_SECTIONS = new Set(["importers", "packages", "snapshots"]);
const DEPENDENCY_GROUPS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);
const LOCK_KEY = `('(?:[^']|'')*'|"(?:[^"\\\\]|\\\\.)*"|[^\\s'"#](?:(?!\\s#).)*?)`;
const SECTION_KEY = new RegExp(`^ {2}${LOCK_KEY}:( \\{\\})?$`);
const GROUP_KEY = /^ {4}([A-Za-z]+):(.*)$/;
const IMPORTER_DEP_KEY = new RegExp(`^ {6}${LOCK_KEY}:$`);
const IMPORTER_DEP_FIELD = /^ {8}(specifier|version):(.*)$/;
const SNAPSHOT_DEP = new RegExp(`^ {6}${LOCK_KEY}: (.+)$`);

/**
 * Registry packages from a pnpm v9 lockfile `packages:`.
 * The lockfile is read line by line, so every line must have the shape pnpm writes: anything
 * else (comments, flow collections, other indentation) would let pnpm read entries this parser
 * does not see, and lands in `rejected`. So do git and other-host packages, a tarball not named
 * after its key, a lockfile other than 9.0, and importers / snapshots / packages that disagree.
 * `skipped` holds workspace directories only.
 * @param {string} lockText
 * @returns {{ lockfileVersion: string | null, byKey: Map<string, LockPackageRef>, skipped: LockEntryNote[], rejected: LockEntryNote[] }}
 */
function collectPnpmLockPackages(lockText) {
  /** @type {Map<string, LockPackageRef>} */
  const byKey = new Map();
  /** @type {LockEntryNote[]} */
  const skipped = [];
  /** @type {LockEntryNote[]} */
  const rejected = [];
  /** @param {string} kind @param {string} detail */
  const reject = (kind, detail) => rejected.push({ kind, detail });

  // YAML reads these as line breaks / content that a split on "\n" does not see
  if (lockText.includes("\uFEFF")) reject("lockfile-syntax", "byte order mark");
  if (/\r(?!\n)/.test(lockText)) reject("lockfile-syntax", "carriage return without line feed");

  /** @type {Map<string, string | null>} */
  const resolutions = new Map();
  /** @type {Set<string>} */
  const snapshotKeys = new Set();
  /** @type {{ from: string, key: string }[]} */
  const references = [];
  /** @type {Set<string>} */
  const topLevel = new Set();
  /** @type {string | null} */
  let lockfileVersion = null;
  /** @type {string | null} */
  let section = null;
  /** @type {string | null} */
  let entry = null;
  let entryHasBody = false;
  /** @type {string | null} */
  let group = null;
  /** @type {{ from: string, name: string, version: string | null } | null} */
  let importerDep = null;

  const closeImporterDep = () => {
    if (!importerDep) return;
    const { from, name, version } = importerDep;
    if (version == null) reject("lockfile-syntax", `${from}: ${name} has no version`);
    else if (!version.startsWith("link:")) references.push({ from, key: dependencyKey(name, version) });
    importerDep = null;
  };

  const lines = lockText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const where = `line ${i + 1}`;
    if (/^\s*$/.test(line)) continue;
    if (/^\s*#/.test(line)) {
      reject("lockfile-syntax", `${where}: comment`);
      continue;
    }

    if (!line.startsWith(" ")) {
      closeImporterDep();
      entry = group = null;
      const top = line.match(/^([A-Za-z]+):(.*)$/);
      if (!top) {
        reject("lockfile-syntax", `${where}: ${line}`);
        section = null;
        continue;
      }
      const [, key, rest] = top;
      if (topLevel.has(key)) reject("lockfile-syntax", `${where}: ${key} appears twice`);
      topLevel.add(key);
      section = key;
      const value = rest.trim();
      if (key === "lockfileVersion") lockfileVersion = yamlScalar(value);
      if (LOCK_SECTIONS.has(key) && value !== "" && value !== "{}") {
        reject("lockfile-syntax", `${where}: ${key} is not written as a block`);
      }
      continue;
    }

    if (section === "packages" || section === "snapshots") {
      const keyMatch = line.match(SECTION_KEY);
      if (keyMatch) {
        entry = yamlScalar(keyMatch[1]);
        entryHasBody = !keyMatch[2];
        group = null;
        if (section === "packages") {
          if (resolutions.has(entry)) reject("lockfile-syntax", `${where}: ${entry} appears twice`);
          resolutions.set(entry, null);
        } else {
          if (snapshotKeys.has(entry)) reject("lockfile-syntax", `${where}: ${entry} appears twice`);
          snapshotKeys.add(entry);
        }
        continue;
      }
      if (!entry || !entryHasBody || !/^ {4,}\S/.test(line)) {
        reject("lockfile-syntax", `${where}: ${line.trim()}`);
        continue;
      }
      if (section === "packages") {
        const res = line.match(/^ {4}resolution:(.*)$/);
        if (res) {
          if (resolutions.get(entry) != null) reject("lockfile-syntax", `${where}: second resolution for ${entry}`);
          else resolutions.set(entry, res[1].trim());
        }
        continue;
      }
      const groupMatch = line.match(GROUP_KEY);
      if (groupMatch) {
        group = groupMatch[1];
        if (DEPENDENCY_GROUPS.has(group) && !["", "{}"].includes(groupMatch[2].trim())) {
          reject("lockfile-syntax", `${where}: ${entry} ${group} is not written as a block`);
        }
        continue;
      }
      if (group && DEPENDENCY_GROUPS.has(group)) {
        const dep = line.match(SNAPSHOT_DEP);
        if (!dep) {
          reject("lockfile-syntax", `${where}: ${line.trim()}`);
          continue;
        }
        const version = yamlScalar(dep[2]);
        if (!version.startsWith("link:")) {
          references.push({ from: entry, key: dependencyKey(yamlScalar(dep[1]), version) });
        }
      }
      continue;
    }

    if (section === "importers") {
      const keyMatch = line.match(SECTION_KEY);
      if (keyMatch) {
        closeImporterDep();
        entry = yamlScalar(keyMatch[1]);
        entryHasBody = !keyMatch[2];
        group = null;
        continue;
      }
      if (!entry || !entryHasBody) {
        reject("lockfile-syntax", `${where}: ${line.trim()}`);
        continue;
      }
      const groupMatch = line.match(GROUP_KEY);
      if (groupMatch) {
        closeImporterDep();
        group = groupMatch[1];
        if (DEPENDENCY_GROUPS.has(group) && !["", "{}"].includes(groupMatch[2].trim())) {
          reject("lockfile-syntax", `${where}: ${entry} ${group} is not written as a block`);
        }
        continue;
      }
      if (!group || !DEPENDENCY_GROUPS.has(group)) {
        if (!/^ {6,}\S/.test(line)) reject("lockfile-syntax", `${where}: ${line.trim()}`);
        continue;
      }
      const depKey = line.match(IMPORTER_DEP_KEY);
      if (depKey) {
        closeImporterDep();
        importerDep = { from: entry, name: yamlScalar(depKey[1]), version: null };
        continue;
      }
      const field = importerDep && line.match(IMPORTER_DEP_FIELD);
      if (!field) {
        reject("lockfile-syntax", `${where}: ${line.trim()}`);
        continue;
      }
      if (field[1] === "version") {
        if (importerDep.version != null) reject("lockfile-syntax", `${where}: second version`);
        importerDep.version = yamlScalar(field[2]);
      }
      continue;
    }
  }
  closeImporterDep();

  if (lockfileVersion !== "9.0") {
    rejected.push({
      kind: "lockfile-version",
      detail: `lockfileVersion ${lockfileVersion ?? "(missing)"}, expected 9.0`,
    });
  }

  for (const [key, rawResolution] of resolutions) {
    const note = classifyLockPackage(key, rawResolution);
    if (note.kind === "registry") {
      const { name, version, detail: integrity } = /** @type {Required<LockEntryNote>} */ (note);
      const id = `${name}@${version}`;
      const existing = byKey.get(id);
      if (existing) existing.paths.push(key);
      else byKey.set(id, { name, version, integrity, paths: [key] });
    } else if (note.kind === "local") {
      skipped.push(note);
    } else {
      rejected.push(note);
    }
  }

  const snapshotBases = new Set([...snapshotKeys].map(stripPeerSuffix));
  for (const key of resolutions.keys()) {
    if (!snapshotBases.has(key)) {
      reject("snapshot-mismatch", `${key} is in packages but not in snapshots`);
    }
  }
  for (const base of snapshotBases) {
    if (!resolutions.has(base)) {
      reject("snapshot-mismatch", `${base} is in snapshots but not in packages`);
    }
  }
  for (const { from, key } of references) {
    if (!snapshotKeys.has(key)) reject("snapshot-mismatch", `${from} depends on ${key}, which is not in snapshots`);
  }

  return { lockfileVersion, byKey, skipped, rejected };
}

/**
 * The snapshots key a dependency entry points at: `name@version`, or the version itself when it
 * names another package (an npm: alias).
 * @param {string} name
 * @param {string} version
 */
function dependencyKey(name, version) {
  return stripPeerSuffix(version).includes("@") ? version : `${name}@${version}`;
}

/**
 * @param {string} key
 * @param {string | null} rawResolution
 * @returns {LockEntryNote}
 */
function classifyLockPackage(key, rawResolution) {
  const parsed = parsePnpmPackageKey(key);
  if (!parsed) return { kind: "invalid", detail: key };
  const { name, version } = parsed;
  const resolution = parseFlowMap(rawResolution);
  if (!resolution) {
    return { kind: "invalid", name, version, detail: `resolution ${rawResolution ?? "(missing)"}` };
  }
  if (resolution.type === "directory") {
    return { kind: "local", name, version, detail: resolution.directory ?? key };
  }
  if (resolution.type === "git" || resolution.commit || resolution.repo) {
    return { kind: "git", name, version, detail: rawResolution ?? key };
  }
  if (resolution.type) {
    return { kind: "non-registry", name, version, detail: rawResolution ?? key };
  }
  if (resolution.tarball !== undefined) {
    /** @type {URL | null} */
    let url = null;
    try {
      url = new URL(resolution.tarball);
    } catch {
      /* not an absolute URL */
    }
    if (!url || url.protocol !== "https:" || url.host !== NPM_REGISTRY_HOST) {
      return { kind: "non-registry", name, version, detail: resolution.tarball };
    }
    const expected = `/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
    if (url.pathname !== expected || url.search || url.hash) {
      return {
        kind: "tarball-mismatch",
        name,
        version,
        detail: `${resolution.tarball} (expected ${expected})`,
      };
    }
  }
  if (!EXACT_SEMVER.test(version)) {
    return { kind: "invalid", name, version, detail: key };
  }
  if (!resolution.integrity) {
    return { kind: "no-integrity", name, version, detail: rawResolution ?? key };
  }
  return { kind: "registry", name, version, detail: resolution.integrity };
}

/**
 * @param {string} raw
 * @returns {{ name: string, version: string } | null}
 */
function parsePnpmPackageKey(raw) {
  const key = stripPeerSuffix(raw);
  const at = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
  if (at <= 0) return null;
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  if (!version || !/^(?:@[^/@\s]+\/)?[^/@\s]+$/.test(name)) return null;
  return { name, version };
}

/** @param {string} key */
function stripPeerSuffix(key) {
  const peer = key.indexOf("(");
  return peer === -1 ? key : key.slice(0, peer);
}

/**
 * One-line YAML flow mapping as pnpm writes `resolution: {...}`.
 * @param {string | null} raw
 * @returns {Record<string, string> | null}
 */
function parseFlowMap(raw) {
  const body = raw?.match(/^\{(.*)\}$/)?.[1];
  if (!body) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of body.split(/,\s*(?=[A-Za-z]+:\s)/)) {
    const kv = part.match(/^\s*([A-Za-z]+):\s*(.*?)\s*$/);
    if (!kv) return null;
    out[kv[1]] = yamlScalar(kv[2]);
  }
  return out;
}

/**
 * A plain, single-quoted or double-quoted YAML scalar, with a trailing comment removed.
 * @param {string} raw
 */
function yamlScalar(raw) {
  const s = raw.trim();
  const single = s.match(/^'((?:[^']|'')*)'/);
  if (single) return single[1].replace(/''/g, "'");
  const double = s.match(/^"((?:[^"\\]|\\.)*)"/);
  if (double) {
    try {
      return JSON.parse(`"${double[1]}"`);
    } catch {
      // YAML-only escapes such as \x: kept verbatim so the name matches nothing
      return s;
    }
  }
  return s.replace(/(?:^|\s+)#.*$/, "").trim();
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;
const USAGE = [
  "Usage: node scripts/audit-min-release-age.mjs [--days N] [--json] [--allow-unknown]",
  "  --allow-unknown  pass packages whose registry data could not be fetched;",
  "                   their publish age and integrity are then not checked",
].join("\n");

const args = process.argv.slice(2);
const workspaceText = readRepoFile("pnpm-workspace.yaml");
let days = readMinReleaseAgeDays();
let jsonOut = false;
let allowUnknown = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--days") {
    const value = args[++i];
    if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) {
      console.error("--days must be a number of 0 or more");
      process.exit(1);
    }
    days = Number(value);
  } else if (arg === "--json") {
    jsonOut = true;
  } else if (arg === "--allow-unknown") {
    allowUnknown = true;
  } else if (arg === "--help" || arg === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    console.error(USAGE);
    process.exit(1);
  }
}

if (!Number.isFinite(days) || days < 0) {
  console.error("--days must be a number of 0 or more");
  process.exit(1);
}

const cutoff = Date.now() - days * 86_400_000;

/** @param {string} file */
function readRepoFile(file) {
  try {
    return fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    return null;
  }
}

function readMinReleaseAgeDays() {
  const minutes = workspaceText?.match(/^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/m);
  if (minutes) return Number(minutes[1]) / (24 * 60);
  const npmrc = readRepoFile(".npmrc");
  const npmrcMinutes = npmrc?.match(/^\s*minimum-release-age\s*=\s*(\d+)\s*(?:[#;].*)?$/m);
  if (npmrcMinutes) return Number(npmrcMinutes[1]) / (24 * 60);
  const npmrcDays = npmrc?.match(/^\s*min-release-age\s*=\s*(\d+)\s*(?:[#;].*)?$/m);
  if (npmrcDays) return Number(npmrcDays[1]);
  return 7;
}

/**
 * Top-level YAML sequence (block or flow) from pnpm-workspace.yaml.
 * @param {string | null} text
 * @param {string} key
 * @returns {string[]}
 */
function readWorkspaceList(text, key) {
  if (!text) return [];
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start === -1) return [];
  const inline = yamlScalar(lines[start].slice(key.length + 1));
  if (inline.startsWith("[") && inline.endsWith("]")) {
    return inline
      .slice(1, -1)
      .split(",")
      .map((s) => yamlScalar(s))
      .filter(Boolean);
  }
  if (inline) throw new Error(`${key}: expected a list`);
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (!item) break;
    items.push(yamlScalar(item[1]));
  }
  return items;
}

/**
 * Registry settings in this repository's .npmrc and pnpm-workspace.yaml (`scope` null for the
 * default registry).
 * @returns {{ source: string, scope: string | null, url: string }[]}
 */
function readRepoRegistries() {
  /** @type {{ source: string, scope: string | null, url: string }[]} */
  const found = [];
  for (const line of (readRepoFile(".npmrc") ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*(["']?)(?:(@[^:\s=]+):)?registry\1\s*=\s*(.*?)\s*$/);
    if (m) found.push({ source: ".npmrc", scope: m[2] ?? null, url: m[3].replace(/^(['"])(.*)\1$/, "$2") });
  }
  const source = "pnpm-workspace.yaml";
  /** @param {string} key @param {string} url */
  const add = (key, url) => found.push({ source, scope: key === "default" ? null : key, url });
  const lines = (workspaceText ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const top = lines[i].match(/^(["']?)(registry|registries)\1\s*:(.*)$/);
    if (!top) continue;
    const value = yamlScalar(top[3]);
    if (top[2] === "registry") {
      add("default", value);
      continue;
    }
    if (value) {
      const body = value.match(/^\{(.*)\}$/)?.[1];
      const entries = body
        ?.split(",")
        .filter((part) => part.trim())
        .map((part) => part.match(/^\s*(.+?):\s+(.+?)\s*$/));
      if (!entries || entries.some((e) => !e)) {
        add("default", value);
        continue;
      }
      for (const entry of entries) {
        const [, key, url] = /** @type {RegExpMatchArray} */ (entry);
        add(yamlScalar(key), yamlScalar(url));
      }
      continue;
    }
    for (const line of lines.slice(i + 1)) {
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      const m = line.match(/^\s+(\S.*?):\s*(\S.*)$/);
      if (!m) break;
      add(yamlScalar(m[1]), yamlScalar(m[2]));
    }
  }
  return found;
}

/**
 * Registries as pnpm resolves its configuration (repository, user and global .npmrc, environment).
 * `pnpm ls` reports registry.npmjs.org URLs whatever the registry setting, so this is checked here.
 * @returns {{ source: string, scope: string | null, url: string }[]}
 */
function readPnpmConfigRegistries() {
  const config = JSON.parse(runPnpm(["config", "list", "--json"]));
  /** @type {{ source: string, scope: string | null, url: string }[]} */
  const found = [];
  for (const [key, value] of Object.entries(config)) {
    const m = key.match(/^(?:(@[^:]+):)?registry$/);
    if (m) found.push({ source: "pnpm config", scope: m[1] ?? null, url: String(value) });
  }
  for (const [key, value] of Object.entries(config.registries ?? {})) {
    found.push({ source: "pnpm config", scope: key === "default" ? null : key, url: String(value) });
  }
  return found;
}

/** @param {string} url */
function isNpmRegistry(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.host === NPM_REGISTRY_HOST;
  } catch {
    return false;
  }
}

/**
 * minimumReleaseAgeExclude as pnpm parses it: `name` or a `*` pattern excludes every version,
 * `name@1.2.3 || 1.2.4` only those versions, and only the first rule whose name matches is used.
 * The audit honours exact versions only.
 * @param {string[]} patterns
 * @returns {{ pattern: string, name: string, versions: string[] | null }[]}
 */
function parseReleaseAgeExclude(patterns) {
  return patterns.map((pattern) => {
    const at = pattern.startsWith("@") ? pattern.indexOf("@", 1) : pattern.indexOf("@");
    if (at === -1) return { pattern, name: pattern, versions: null };
    const name = pattern.slice(0, at);
    const versions = pattern
      .slice(at + 1)
      .split("||")
      .map((v) => v.trim().replace(/^v/, "").replace(/\+.*$/, ""));
    if (name.includes("*") || versions.some((v) => !EXACT_SEMVER.test(v))) {
      throw new Error(`minimumReleaseAgeExclude: "${pattern}" is not name@exact[ || exact]`);
    }
    return { pattern, name, versions };
  });
}

/**
 * @param {{ name: string, versions: string[] | null }[]} rules
 * @param {string} name
 */
function firstExcludeRule(rules, name) {
  return rules.find((r) =>
    r.name.includes("*")
      ? new RegExp(`^${r.name.split("*").map(escapeRegExp).join(".*")}$`).test(name)
      : r.name === name,
  );
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string | null} header
 * @returns {number | null}
 */
function retryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, 0), MAX_RETRY_WAIT_MS);
}

/** @param {string} name */
function registryPackumentUrl(name) {
  const encoded = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  return `https://${NPM_REGISTRY_HOST}/${encoded}`;
}

/**
 * Retries 429 / 5xx (honouring Retry-After), timeouts and network errors.
 * @param {string} name
 */
async function fetchPackument(name) {
  for (let attempt = 0; ; attempt++) {
    const backoff = 1000 * 2 ** attempt;
    /** @type {Response} */
    let res;
    try {
      res = await fetch(registryPackumentUrl(name), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        await sleep(backoff);
        continue;
      }
      const err = /** @type {Error} */ (e);
      const reason =
        err.name === "TimeoutError" ? `no response in ${FETCH_TIMEOUT_MS / 1000}s` : String(err.message ?? e);
      throw new Error(`${name}: ${reason}`);
    }
    if (res.status === 404) return null;
    if (res.ok) {
      try {
        return await res.json();
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          await sleep(backoff);
          continue;
        }
        throw new Error(`${name}: unreadable registry response (${String(/** @type {Error} */ (e).message ?? e)})`);
      }
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await res.body?.cancel();
      await sleep(retryAfterMs(res.headers.get("retry-after")) ?? backoff);
      continue;
    }
    throw new Error(`${name}: registry ${res.status} ${res.statusText}`);
  }
}

/**
 * The integrity pnpm records for a registry version: dist.integrity, or the sha1 shasum.
 * @param {{ integrity?: string, shasum?: string } | undefined} dist
 */
function publishedIntegrity(dist) {
  if (dist?.integrity) return dist.integrity;
  if (dist?.shasum) return `sha1-${Buffer.from(dist.shasum, "hex").toString("base64")}`;
  return null;
}

/**
 * Runs the pnpm that launched this script, else pnpm on PATH, else corepack's. Every pnpm
 * command, even --version, loads .pnpmfile.cjs (repository code) unless told not to, and only
 * the environment form of the setting covers all of them.
 * @param {string[]} pnpmArgs
 */
function runPnpm(pnpmArgs) {
  const execPath = process.env.npm_execpath;
  /** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding} */
  const options = {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 ** 3,
    env: { ...process.env, npm_config_ignore_pnpmfile: "true" },
  };
  let r =
    execPath && path.basename(execPath).startsWith("pnpm")
      ? spawnSync(process.execPath, [execPath, ...pnpmArgs], options)
      : spawnSync("pnpm", pnpmArgs, options);
  if (/** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code === "ENOENT") {
    r = spawnSync("corepack", ["pnpm", ...pnpmArgs], options);
  }
  if (r.error || r.status !== 0) {
    const reason = r.error?.message ?? (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ");
    throw new Error(`pnpm ${pnpmArgs.join(" ")}: ${reason}`);
  }
  return r.stdout;
}

/**
 * The packages pnpm itself reads from pnpm-lock.yaml: everything reachable from an importer
 * except workspace links, with the tarball URL pnpm would fetch. Reads the lockfile only.
 */
function readPnpmLs() {
  const projects = JSON.parse(
    runPnpm(["ls", "-r", "--lockfile-only", "--json", "--depth", "Infinity"]),
  );
  /** @type {Map<string, { name: string, version: string, resolved: Set<string> }>} */
  const registry = new Map();
  /** @type {Set<string>} */
  const local = new Set();
  /** @param {Record<string, { from: string, version: string, resolved?: string, dependencies?: object, optionalDependencies?: object }> | undefined} deps */
  const visit = (deps) => {
    for (const dep of Object.values(deps ?? {})) {
      const name = String(dep.from);
      const version = String(dep.version);
      if (version.startsWith("file:")) {
        local.add(`${name}@${version}`);
      } else if (!version.startsWith("link:")) {
        const id = `${name}@${version}`;
        if (!registry.has(id)) registry.set(id, { name, version, resolved: new Set() });
        registry.get(id)?.resolved.add(dep.resolved ?? "");
      }
      visit(/** @type {any} */ (dep.dependencies));
      visit(/** @type {any} */ (dep.optionalDependencies));
    }
  };
  for (const project of projects) {
    visit(project.dependencies);
    visit(project.devDependencies);
    visit(project.optionalDependencies);
  }
  return { registry, local };
}

/**
 * Compares the lockfile parser with what pnpm reads. Every registry package pnpm would install
 * must come from its registry.npmjs.org tarball, and the two views must name the same packages;
 * if either is fooled by the lockfile text, they disagree.
 * @param {Map<string, LockPackageRef>} byKey
 * @param {LockEntryNote[]} skipped
 */
function crossCheckWithPnpm(byKey, skipped) {
  /** @type {LockEntryNote[]} */
  const problems = [];
  /** @type {Map<string, LockPackageRef>} */
  const auditSet = new Map(byKey);
  let ls;
  try {
    const wanted = /^pnpm@([^+]+)/.exec(
      JSON.parse(readRepoFile("package.json") ?? "{}").packageManager ?? "",
    )?.[1];
    const actual = runPnpm(["--version"]).trim();
    if (wanted && actual !== wanted) {
      problems.push({ kind: "pnpm-version", detail: `pnpm ${actual}, packageManager pnpm@${wanted}` });
    }
    ls = readPnpmLs();
  } catch (e) {
    problems.push({ kind: "pnpm-ls", detail: String(/** @type {Error} */ (e).message ?? e) });
    return { problems, auditSet };
  }

  for (const [id, { name, version, resolved }] of ls.registry) {
    const expected = `https://${NPM_REGISTRY_HOST}/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
    for (const url of resolved) {
      if (url !== expected) {
        problems.push({
          kind: "pnpm-resolved",
          name,
          version,
          detail: `pnpm fetches ${url || "(no URL)"}, expected ${expected}`,
        });
      }
    }
    if (!byKey.has(id)) {
      problems.push({ kind: "parser-mismatch", name, version, detail: "pnpm installs it, the lockfile parser does not see it" });
      auditSet.set(id, { name, version, integrity: null, paths: ["(pnpm ls)"] });
    }
  }
  for (const [id, { name, version }] of byKey) {
    if (!ls.registry.has(id)) {
      problems.push({ kind: "parser-mismatch", name, version, detail: "the lockfile parser sees it, pnpm does not install it" });
    }
  }
  const parserLocal = new Set(skipped.map((s) => `${s.name}@${s.version}`));
  for (const id of ls.local) {
    if (!parserLocal.has(id)) problems.push({ kind: "parser-mismatch", detail: `${id}: local to pnpm, not to the lockfile parser` });
  }
  for (const id of parserLocal) {
    if (!ls.local.has(id)) problems.push({ kind: "parser-mismatch", detail: `${id}: local to the lockfile parser, not to pnpm` });
  }
  return { problems, auditSet };
}

/** @param {Map<string, LockPackageRef>} byKey */
async function auditRefs(byKey) {
  /** @type {Map<string, Set<string>>} */
  const versionsByName = new Map();
  for (const { name, version } of byKey.values()) {
    if (!versionsByName.has(name)) versionsByName.set(name, new Set());
    versionsByName.get(name).add(version);
  }

  /** @type {{ name: string, version: string, publishedAt: string, ageDays: number, paths: string[] }[]} */
  const violations = [];
  /** @type {{ name: string, version: string, reason: string, paths: string[] }[]} */
  const unknown = [];
  /** @type {{ name: string, version: string, paths: string[] }[]} */
  const notFound = [];
  /** @type {{ name: string, version: string, lockfile: string, registry: string | null }[]} */
  const integrityMismatch = [];

  const names = [...versionsByName.keys()].sort();
  const concurrency = 12;
  for (let i = 0; i < names.length; i += concurrency) {
    const batch = names.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (name) => {
        let packument;
        try {
          packument = await fetchPackument(name);
        } catch (e) {
          for (const version of versionsByName.get(name)) {
            const ref = byKey.get(`${name}@${version}`);
            unknown.push({
              name,
              version,
              reason: String(/** @type {Error} */ (e).message ?? e),
              paths: ref?.paths ?? [],
            });
          }
          return;
        }

        if (!packument) {
          for (const version of versionsByName.get(name)) {
            const ref = byKey.get(`${name}@${version}`);
            notFound.push({ name, version, paths: ref?.paths ?? [] });
          }
          return;
        }

        const times = packument?.time ?? {};
        for (const version of versionsByName.get(name)) {
          const ref = /** @type {LockPackageRef} */ (byKey.get(`${name}@${version}`));
          const paths = ref.paths;
          const registryIntegrity = publishedIntegrity(packument?.versions?.[version]?.dist);
          if (
            ref.integrity != null &&
            (registryIntegrity == null || !registryIntegrity.split(/\s+/).includes(ref.integrity))
          ) {
            integrityMismatch.push({
              name,
              version,
              lockfile: ref.integrity,
              registry: registryIntegrity,
            });
          }
          const publishedRaw = times[version];
          if (!publishedRaw) {
            unknown.push({
              name,
              version,
              reason: "the registry has no publish time",
              paths,
            });
            continue;
          }
          const publishedMs = Date.parse(publishedRaw);
          if (Number.isNaN(publishedMs)) {
            unknown.push({
              name,
              version,
              reason: `unparsable publish time: ${publishedRaw}`,
              paths,
            });
            continue;
          }
          if (publishedMs > cutoff) {
            const ageDays = (Date.now() - publishedMs) / 86_400_000;
            violations.push({
              name,
              version,
              publishedAt: publishedRaw,
              ageDays: Math.round(ageDays * 10) / 10,
              paths,
            });
          }
        }
      }),
    );
  }

  violations.sort((a, b) => a.ageDays - b.ageDays);
  return { violations, unknown, notFound, integrityMismatch };
}

const lockText = readRepoFile("pnpm-lock.yaml");
if (lockText == null) {
  console.error("pnpm-lock.yaml is missing. Run pnpm install at the repository root.");
  process.exit(1);
}
/** @type {ReturnType<typeof parseReleaseAgeExclude>} */
let excludeRules;
try {
  excludeRules = parseReleaseAgeExclude(
    readWorkspaceList(workspaceText, "minimumReleaseAgeExclude"),
  );
} catch (e) {
  console.error(String(/** @type {Error} */ (e).message ?? e));
  process.exit(1);
}
const { lockfileVersion, byKey, skipped, rejected } = collectPnpmLockPackages(lockText);
const { problems: pnpmProblems, auditSet } = crossCheckWithPnpm(byKey, skipped);
rejected.push(...pnpmProblems);
/** @type {{ source: string, scope: string | null, url: string }[]} */
let configRegistries = [];
try {
  configRegistries = readPnpmConfigRegistries();
} catch (e) {
  rejected.push({ kind: "pnpm-config", detail: String(/** @type {Error} */ (e).message ?? e) });
}
const otherRegistries = [...readRepoRegistries(), ...configRegistries].filter(
  (r) => !isNpmRegistry(r.url),
);
const registryProblems = otherRegistries.filter(
  (r) => r.scope == null || [...auditSet.values()].some((p) => p.name.startsWith(`${r.scope}/`)),
);
const unusedRegistries = otherRegistries.filter((r) => !registryProblems.includes(r));
const uniqueCount = auditSet.size;
const audited = await auditRefs(auditSet);
const { unknown, notFound, integrityMismatch } = audited;
const violations = audited.violations.filter(
  (v) => !firstExcludeRule(excludeRules, v.name)?.versions?.includes(v.version),
);
const excluded = audited.violations.filter((v) => !violations.includes(v));
const nameOnlyExcludes = excludeRules.filter((r) => !r.versions).map((r) => r.pattern);

const cutoffIso = new Date(cutoff).toISOString();
const summary = {
  minReleaseAgeDays: days,
  cutoffIso,
  lockfileVersion,
  scannedUnique: uniqueCount,
  violations: violations.length,
  excluded: excluded.length,
  unknown: unknown.length,
  notOnRegistry: notFound.length,
  integrityMismatch: integrityMismatch.length,
  otherRegistries: registryProblems.length,
  rejected: rejected.length,
  skipped: skipped.length,
};

if (jsonOut) {
  console.log(
    JSON.stringify(
      {
        ...summary,
        violationList: violations,
        excludedList: excluded,
        unknownList: unknown,
        notOnRegistryList: notFound,
        integrityMismatchList: integrityMismatch,
        otherRegistryList: registryProblems,
        unusedScopedRegistryList: unusedRegistries,
        rejectedList: rejected,
        skippedList: skipped,
        ignoredNameOnlyExcludes: nameOnlyExcludes,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`minimumReleaseAge audit (${days} days)`);
  console.log(`Published before: ${cutoffIso}`);
  console.log(`Unique registry packages: ${uniqueCount}`);
  console.log(`Workspace directories (skipped): ${skipped.length}`);
  console.log(`Lockfile entries not checkable against the registry: ${rejected.length}`);
  console.log(`Registries other than registry.npmjs.org in use: ${registryProblems.length}`);
  console.log(`Not on the registry: ${notFound.length}`);
  console.log(`Integrity differing from the registry: ${integrityMismatch.length}`);
  console.log(`Unknown publish time: ${unknown.length}`);
  console.log(`Excluded by minimumReleaseAgeExclude: ${excluded.length}`);
  console.log(`Violations (published less than ${days} days ago): ${violations.length}`);
  console.log("");

  if (violations.length) {
    console.log("--- Violations (newest first) ---");
    for (const v of violations) {
      console.log(`${v.name}@${v.version}  published ${v.publishedAt}  (${v.ageDays} days ago)`);
      if (v.paths.length === 1) {
        console.log(`  └ ${v.paths[0]}`);
      } else {
        console.log(`  └ referenced in ${v.paths.length} places`);
      }
    }
    console.log("");
  }

  if (excluded.length) {
    console.log("--- Excluded by minimumReleaseAgeExclude ---");
    for (const v of excluded) {
      console.log(`${v.name}@${v.version}  published ${v.publishedAt}  (${v.ageDays} days ago)`);
    }
    console.log("");
  }

  if (nameOnlyExcludes.length) {
    console.log("--- minimumReleaseAgeExclude entries without exact versions (not honoured here) ---");
    for (const p of nameOnlyExcludes) console.log(p);
    console.log("");
  }

  if (rejected.length) {
    console.log("--- Lockfile entries not checkable against the registry ---");
    for (const r of rejected) {
      console.log(`[${r.kind}] ${r.name ? `${r.name}@${r.version}: ` : ""}${r.detail ?? ""}`);
    }
    console.log("");
  }

  if (registryProblems.length) {
    console.log("--- Registries other than registry.npmjs.org in use ---");
    for (const r of registryProblems) console.log(`${r.source}: ${r.scope ?? "(default)"} ${r.url}`);
    console.log("");
  }

  if (unusedRegistries.length) {
    console.log("--- Scoped registries with no package in the lockfile (not a failure) ---");
    for (const r of unusedRegistries) console.log(`${r.source}: ${r.scope} ${r.url}`);
    console.log("");
  }

  if (notFound.length) {
    console.log("--- Not on the registry ---");
    for (const n of notFound) console.log(`${n.name}@${n.version}`);
    console.log("");
  }

  if (integrityMismatch.length) {
    console.log("--- Integrity differing from the registry ---");
    for (const m of integrityMismatch) {
      console.log(`${m.name}@${m.version}: lockfile ${m.lockfile}, registry ${m.registry ?? "(none)"}`);
    }
    console.log("");
  }

  if (unknown.length) {
    console.log("--- Unknown publish time ---");
    for (const u of unknown.slice(0, 20)) {
      console.log(`${u.name}@${u.version}: ${u.reason}`);
    }
    if (unknown.length > 20) {
      console.log(`... and ${unknown.length - 20} more`);
    }
    console.log("");
  }
}

if (unknown.length > 0 && !allowUnknown) {
  console.error(
    "An unknown publish time fails the audit. Pass --allow-unknown only in an emergency.",
  );
}

if (
  violations.length > 0 ||
  rejected.length > 0 ||
  registryProblems.length > 0 ||
  notFound.length > 0 ||
  integrityMismatch.length > 0 ||
  (unknown.length > 0 && !allowUnknown)
) {
  process.exit(1);
}
