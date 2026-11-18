// node --test scripts/
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { EXCEPTIONS_FILE, invalidException, judgeAudit, minReleaseAgeDaysFrom } from "./audit-security.mjs";

const now = Date.parse("2026-11-18T12:00:00Z");
const ghsa = "GHSA-fc5q-39xc-vjpf";

/** @param {Partial<import("./audit-security.mjs").Advisory>} over */
function advisory(over = {}) {
  return {
    github_advisory_id: ghsa,
    module_name: "picomatch",
    severity: "high",
    vulnerable_versions: "<=4.0.7",
    patched_versions: "<0.0.0",
    findings: [{ version: "4.0.7", paths: ["packages__manu-propria>vitest>tinyglobby>picomatch"] }],
    ...over,
  };
}

const exception = {
  id: ghsa,
  package: "picomatch",
  versions: ["4.0.7"],
  reason: "dev only",
  decided: "2026-11-18",
  until: "2026-12-18",
};

const empty = { advisories: {} };
const noFetch = async () => {
  throw new Error("unexpected fetch");
};

/** @param {Partial<Parameters<typeof judgeAudit>[0]>} over */
function judge(over) {
  return judgeAudit({
    report: { advisories: { 1: advisory() } },
    prodReport: empty,
    exceptions: [exception],
    now,
    minReleaseAgeDays: 7,
    fetchPackument: noFetch,
    ...over,
  });
}

/** @param {string[]} failures @param {string} text */
function mentions(failures, text) {
  assert.ok(failures.join("\n").includes(text), `expected "${text}" in:\n${failures.join("\n")}`);
}

describe("audit exceptions for advisories with no fixed release", () => {
  it("passes an unfixed advisory that its exception covers", async () => {
    const r = await judge({});
    assert.deepEqual(r.failures, []);
    assert.equal(r.excepted.length, 1);
  });

  it("passes when nothing high is found and there is no exception", async () => {
    const r = await judge({ report: { advisories: { 2: advisory({ severity: "moderate" }) } }, exceptions: [] });
    assert.deepEqual(r.failures, []);
  });

  it("fails a high or critical advisory with no exception", async () => {
    assert.equal((await judge({ exceptions: [] })).failures.length, 1);
    const critical = { advisories: { 1: advisory({ severity: "critical" }) } };
    assert.equal((await judge({ report: critical, exceptions: [] })).failures.length, 1);
  });

  it("never excepts the published dependencies", async () => {
    const r = await judge({ prodReport: { advisories: { 1: advisory() } } });
    mentions(r.failures, "published dependencies");
  });

  it("fails when the audit cannot be read", async () => {
    for (const bad of [{ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: "403" } }, {}]) {
      assert.equal((await judge({ report: bad })).failures.length, 1);
      assert.equal((await judge({ prodReport: bad })).failures.length, 1);
    }
  });

  it("fails after the exception's last day", async () => {
    assert.deepEqual((await judge({ now: Date.parse("2026-12-18T23:59:59Z") })).failures, []);
    mentions((await judge({ now: Date.parse("2026-12-19T00:00:00Z") })).failures, "ended on 2026-12-18");
  });

  it("fails a version the exception does not name, and a different package", async () => {
    const other = advisory({ findings: [{ version: "4.0.8", paths: ["."] }] });
    mentions((await judge({ report: { advisories: { 1: other } } })).failures, "4.0.8");
    const micromatch = { advisories: { 1: advisory({ module_name: "micromatch" }) } };
    assert.equal((await judge({ report: micromatch })).failures.length, 1);
  });

  it("fails an exception that no longer matches an advisory", async () => {
    mentions((await judge({ report: empty })).failures, "drop the exception");
  });

  it("fails an exception listed twice", async () => {
    mentions((await judge({ exceptions: [exception, exception] })).failures, "appears twice");
  });

  it("rejects malformed exceptions and ones longer than 30 days", () => {
    assert.equal(invalidException(exception), null);
    assert.notEqual(invalidException({ ...exception, until: "2026-12-19" }), null);
    assert.notEqual(invalidException({ ...exception, until: "2026-11-17" }), null);
    assert.notEqual(invalidException({ ...exception, until: "2026-11-31" }), null);
    assert.notEqual(invalidException({ ...exception, reason: " " }), null);
    assert.notEqual(invalidException({ ...exception, versions: ["^4.0.7"] }), null);
    assert.notEqual(invalidException({ ...exception, versions: [] }), null);
    assert.notEqual(invalidException({ ...exception, id: "CVE-2026-1" }), null);
  });

  describe("once a fix is published", () => {
    const patched = { report: { advisories: { 1: advisory({ patched_versions: ">=4.0.8" }) } } };
    const packument = (/** @type {Record<string, string>} */ time) => async () => ({ time });

    it("keeps the exception until the fix is old enough to install", async () => {
      const r = await judge({
        ...patched,
        fetchPackument: packument({ "4.0.7": "2026-08-24T00:00:00Z", "4.0.8": "2026-11-15T00:00:00Z" }),
      });
      assert.deepEqual(r.failures, []);
      assert.ok(r.excepted.join("\n").includes("2026-11-22"));
    });

    it("fails once the fix is past the release age", async () => {
      const r = await judge({ ...patched, fetchPackument: packument({ "4.0.8": "2026-11-10T00:00:00Z" }) });
      mentions(r.failures, "update the lockfile");
    });

    it("fails closed when the range or the registry cannot be read", async () => {
      const unreadable = { advisories: { 1: advisory({ patched_versions: "^4.0.8 || >=5.0.1" }) } };
      assert.equal((await judge({ report: unreadable })).failures.length, 1);
      assert.equal((await judge({ ...patched })).failures.length, 1);
      const noFix = packument({ "4.0.7": "2026-08-24T00:00:00Z" });
      assert.equal((await judge({ ...patched, fetchPackument: noFix })).failures.length, 1);
    });
  });

  it("reads minimumReleaseAge in minutes", () => {
    assert.equal(minReleaseAgeDaysFrom("minimumReleaseAge: 10080\n"), 7);
    assert.equal(minReleaseAgeDaysFrom(null), 7);
  });

  it("keeps every checked-in exception well formed", () => {
    const file = path.resolve(import.meta.dirname, "..", EXCEPTIONS_FILE);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const e of doc.exceptions) assert.equal(invalidException(e), null, e.id);
  });
});
