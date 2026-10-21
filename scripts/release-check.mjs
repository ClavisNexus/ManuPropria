#!/usr/bin/env node
// Checks a release before .github/workflows/publish.yml stages it on npm.
//
//   node scripts/release-check.mjs tag <dir>-v<X.Y.Z>
//   node scripts/release-check.mjs tarball <file.tgz> <name> <version>
//
// tag: the tag names a public package under packages/, its package.json carries that version, the
// tagged commit is on origin/main, and the version is new on npm and above its latest. Writes dir,
// name and version to $GITHUB_OUTPUT when set.
// tarball: the packed package.json has that name and version, this repository's URL (npm refuses
// trusted publishing otherwise) and publishConfig {"access":"public"}, its dependencies are registry
// versions or ranges, and every dependency on a workspace package is an exact
// version npm already serves. A workspace package that is not on npm (a private copy) packs as a
// version nobody can install, so it fails here. Writes the integrity and file list to
// $GITHUB_STEP_SUMMARY for whoever approves the staged package.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmjs.org";
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

function fail(message) {
  console.error(`[release-check] ${message}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function workspacePackages() {
  const dir = join(repo, "packages");
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: entry.name, manifest: readJson(join(dir, entry.name, "package.json")) }));
}

function registryUrl(name, version) {
  const encoded = name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  return `${REGISTRY}/${encoded}${version ? `/${version}` : ""}`;
}

/** The registry document, or null when the registry does not have it. */
async function registryGet(name, version) {
  let res;
  try {
    res = await fetch(registryUrl(name, version), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    fail(`${name}${version ? `@${version}` : ""}: ${e.name === "TimeoutError" ? "registry did not answer in 30 s" : e.message}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) fail(`${name}${version ? `@${version}` : ""}: registry ${res.status} ${res.statusText}`);
  return res.json();
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function output(file, lines) {
  if (file) appendFileSync(file, `${lines.join("\n")}\n`);
}

async function checkTag(tag) {
  const m = /^(.+)-v(.+)$/.exec(tag ?? "");
  if (!m) fail(`tag "${tag}" is not <dir>-v<X.Y.Z>`);
  const [, dir, version] = m;
  if (!RELEASE_VERSION.test(version)) fail(`tag "${tag}": ${version} is not X.Y.Z`);

  const pkg = workspacePackages().find((p) => p.dir === dir);
  if (!pkg) fail(`tag "${tag}": no packages/${dir}`);
  const { name, private: isPrivate, version: manifestVersion } = pkg.manifest;
  if (isPrivate) fail(`${name} is private`);
  if (manifestVersion !== version) fail(`packages/${dir}/package.json has ${manifestVersion}, the tag ${version}`);

  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { cwd: repo, stdio: "ignore" });
  } catch {
    fail(`the tagged commit is not on origin/main`);
  }

  const packument = await registryGet(name);
  // An unpublished version stays in time but leaves versions, and npm never accepts it again
  if (packument?.versions?.[version] || packument?.time?.[version]) fail(`${name}@${version} is or was on npm`);
  const latest = packument?.["dist-tags"]?.latest;
  if (latest && RELEASE_VERSION.test(latest) && compareVersions(version, latest) <= 0) {
    fail(`${name}@${version} is not above latest ${latest}`);
  }

  output(process.env.GITHUB_OUTPUT, [`dir=${dir}`, `name=${name}`, `version=${version}`]);
  console.log(`[release-check] ${name}@${version} (packages/${dir})${latest ? `, latest ${latest}` : ""}`);
}

async function checkTarball(file, name, version) {
  if (!file || !name || !version) fail("tarball needs <file.tgz> <name> <version>");
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" }));
  if (manifest.name !== name || manifest.version !== version) {
    fail(`${basename(file)} is ${manifest.name}@${manifest.version}, expected ${name}@${version}`);
  }

  const repository = `git+https://github.com/${process.env.GITHUB_REPOSITORY ?? "ClavisNexus/ManuPropria"}.git`;
  if (manifest.repository?.url !== repository) {
    fail(`repository.url is ${manifest.repository?.url ?? "(none)"}, expected ${repository}`);
  }

  // A different tag or registry here would change what npm does with the staged package
  if (JSON.stringify(manifest.publishConfig) !== JSON.stringify({ access: "public" })) {
    fail(`publishConfig is ${JSON.stringify(manifest.publishConfig)}, expected {"access":"public"}`);
  }

  const workspaceNames = new Set(workspacePackages().map((p) => p.manifest.name));
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
      // Registry versions and ranges only: no protocol (workspace:, npm:, git+…), path or owner/repo
      if (/[:/\\]/.test(spec) || spec.startsWith(".")) fail(`${field}.${dep} is "${spec}"`);
      if (!workspaceNames.has(dep)) continue;
      if (!RELEASE_VERSION.test(spec)) fail(`${field}.${dep} is "${spec}", not an exact version`);
      if (!(await registryGet(dep, spec))) fail(`${field}.${dep}@${spec} is not on npm`);
    }
  }

  const data = readFileSync(file);
  const integrity = `sha512-${createHash("sha512").update(data).digest("base64")}`;
  const shasum = createHash("sha1").update(data).digest("hex");
  const files = execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).trim().split("\n");
  output(process.env.GITHUB_STEP_SUMMARY, [
    `### ${name}@${version}`,
    "",
    `- integrity: \`${integrity}\``,
    `- shasum: \`${shasum}\``,
    "",
    "```",
    ...files,
    "```",
  ]);
  console.log(`[release-check] ${basename(file)} ${integrity}`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "tag") await checkTag(rest[0]);
else if (mode === "tarball") await checkTarball(rest[0], rest[1], rest[2]);
else fail("usage: release-check.mjs tag <dir>-v<X.Y.Z> | tarball <file.tgz> <name> <version>");
