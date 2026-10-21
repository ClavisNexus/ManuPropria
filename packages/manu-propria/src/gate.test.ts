import { AppClientError } from "@clavis.nexus/app";
import { describe, expect, it } from "vitest";
import type { Call } from "./call.js";
import { messageDigestOf, prepareCall } from "./call.js";
import { createSignatureGate, type SignatureOutcome } from "./gate.js";
import { memoryStore, type SignatureStore } from "./store.js";
import { fakeClavis } from "./test-support/fake-clavis.js";
import { createSignatureGateForTest } from "./test-support/gate.js";

const call: Call = {
  name: "refund",
  arguments: { orderId: "1042", amount: 120 },
  show: "Refund $120.00 on order 1042",
  signer: "pw-alice",
};

/** A clock that only moves when the gate sleeps, so each read happens at a known time. */
function virtualClock() {
  const clock = {
    at: 1_791_747_000_000,
    sleeps: [] as number[],
    now: () => clock.at,
    sleep: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      clock.sleeps.push(ms);
      clock.at += ms;
    },
  };
  return clock;
}

function setup(options: { store?: SignatureStore; ttlSeconds?: number; returnUrl?: string } = {}) {
  const clavis = fakeClavis();
  const store = options.store ?? memoryStore();
  const clock = virtualClock();
  const gate = createSignatureGateForTest({ app: clavis.app, store, ...options }, clock);
  return { clavis, store, gate, clock };
}

function awaiting(outcome: SignatureOutcome) {
  if (outcome.state !== "awaiting") throw new Error(`expected awaiting, got ${outcome.state}`);
  return outcome;
}

function signed(outcome: SignatureOutcome) {
  if (outcome.state !== "signed") throw new Error(`expected signed, got ${outcome.state}`);
  return outcome.signature;
}

describe("signatureFor", () => {
  it("opens a request bound to the call, the line and the signer, and answers at once", async () => {
    const { clavis, gate } = setup({ ttlSeconds: 600 });
    const first = awaiting(await gate.signatureFor({ ...call, uiLocales: ["en-GB", "en"] }, { holdMs: 60_000 }));
    expect(first.fresh).toBe(true);
    expect(first.started).toBe(false);
    expect(first.url).toBe(`https://api.clavis.test/app/intent-requests/consume/${first.requestId}`);
    const { input } = clavis.last();
    expect(input).toMatchObject({
      displayHint: "Refund $120.00 on order 1042",
      allowedSub: "pw-alice",
      ttlSeconds: 600,
      uiLocales: ["en-GB", "en"],
    });
    expect(input.returnUrl).toBeUndefined();
    expect(input.messageDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("picks the same request up while it waits, and says when the person has opened it", async () => {
    const { clavis, gate } = setup();
    const first = awaiting(await gate.signatureFor(call));
    const again = awaiting(await gate.signatureFor(call));
    expect(again).toMatchObject({ requestId: first.requestId, fresh: false, started: false });
    clavis.start();
    expect(awaiting(await gate.signatureFor(call)).started).toBe(true);
    expect(clavis.requests.size).toBe(1);
  });

  it("returns the signed call once the person signs, with the document behind the digest", async () => {
    const { clavis, gate } = setup();
    awaiting(await gate.signatureFor(call));
    clavis.sign();
    const signature = signed(await gate.signatureFor(call));
    expect(signature.signer).toBe("pw-alice");
    expect(signature.document).toMatchObject({ name: "refund", show: "Refund $120.00 on order 1042", signer: "pw-alice" });
    expect(await messageDigestOf(signature.document)).toBe(signature.messageDigest);
    expect(signature.receipt.statement.digest).toBe(signature.messageDigest);
  });

  it("lets one signature run once: the next identical call opens its own request", async () => {
    const { clavis, gate } = setup();
    awaiting(await gate.signatureFor(call));
    clavis.sign();
    const first = signed(await gate.signatureFor(call));
    const next = awaiting(await gate.signatureFor(call));
    expect(next.fresh).toBe(true);
    expect(next.requestId).not.toBe(first.requestId);
    expect(clavis.requests.size).toBe(2);
  });

  it("hands a signature to only one of two concurrent callers", async () => {
    const { clavis, gate } = setup();
    awaiting(await gate.signatureFor(call));
    clavis.sign();
    const [a, b] = await Promise.all([gate.signatureFor(call), gate.signatureFor(call)]);
    expect([a.state, b.state].sort()).toEqual(["awaiting", "signed"]);
  });

  it("reports a lapsed request and starts over on the next call", async () => {
    const { clavis, gate } = setup();
    const first = awaiting(await gate.signatureFor(call));
    clavis.expire();
    expect(await gate.signatureFor(call)).toEqual({ state: "expired", show: "Refund $120.00 on order 1042" });
    const next = awaiting(await gate.signatureFor(call));
    expect(next.fresh).toBe(true);
    expect(next.requestId).not.toBe(first.requestId);
  });

  it("waits for the signature for up to holdMs, reading at the poll interval", async () => {
    const { clavis, gate, clock } = setup();
    awaiting(await gate.signatureFor(call));
    clavis.whenStatusRead((request) => {
      if (request.statusReads === 3) clavis.sign(request);
    });
    const signature = signed(await gate.signatureFor(call, { holdMs: 30_000 }));
    expect(signature.requestId).toBe(clavis.last().requestId);
    expect(clock.sleeps).toEqual([2_500, 2_500]);
  });

  it("stops waiting at holdMs", async () => {
    const { clavis, gate, clock } = setup();
    awaiting(await gate.signatureFor(call));
    expect(awaiting(await gate.signatureFor(call, { holdMs: 6_000 })).fresh).toBe(false);
    expect(clavis.last().statusReads).toBe(3);
    expect(clock.sleeps).toEqual([2_500, 2_500]);
  });

  it("backs off when Clavis limits status reads, and keeps waiting", async () => {
    const { clavis, gate, clock } = setup();
    awaiting(await gate.signatureFor(call));
    clavis.rateLimitNext(2);
    clavis.sign();
    expect(signed(await gate.signatureFor(call, { holdMs: 30_000 })).signer).toBe("pw-alice");
    expect(clock.sleeps).toEqual([5_000, 10_000]);
  });

  it("stops waiting when the caller aborts", async () => {
    const clavis = fakeClavis();
    const controller = new AbortController();
    let sleeping: () => void = () => undefined;
    const gate = createSignatureGateForTest(
      { app: clavis.app, store: memoryStore() },
      {
        now: () => 0,
        sleep: (_ms, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            sleeping();
          }),
      },
    );
    awaiting(await gate.signatureFor(call));
    const asleep = new Promise<void>((resolve) => {
      sleeping = resolve;
    });
    const pending = gate.signatureFor(call, { holdMs: 60_000, signal: controller.signal });
    await asleep;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not wait on a request it has just opened", async () => {
    const { gate, clock } = setup();
    expect(awaiting(await gate.signatureFor(call, { holdMs: 60_000 })).fresh).toBe(true);
    expect(clock.sleeps).toEqual([]);
  });

  it("dates the request from the moment it is opened", async () => {
    const { gate, clock } = setup({ ttlSeconds: 600 });
    expect(awaiting(await gate.signatureFor(call)).expiresAt).toBe(Math.floor(clock.at / 1000) + 600);
  });

  it("refuses a completion signed by someone else or showing another line, and drops the request", async () => {
    for (const as of [{ signer: "pw-mallory" }, { shownAction: "Refund $1.00 on order 1042" }]) {
      const { clavis, gate, store } = setup();
      awaiting(await gate.signatureFor(call));
      clavis.sign(clavis.last(), as);
      await expect(gate.signatureFor(call)).rejects.toMatchObject({ code: "receipt_mismatch" });
      const key = clavis.last().requestId;
      expect(await store.use(key, 60)).toBe(true);
      expect(awaiting(await gate.signatureFor(call)).fresh).toBe(true);
    }
  });

  it("keeps a request for another signer apart", async () => {
    const { clavis, gate } = setup();
    awaiting(await gate.signatureFor(call));
    clavis.sign();
    const bob = awaiting(await gate.signatureFor({ ...call, signer: "pw-bob" }));
    expect(bob.fresh).toBe(true);
    expect(signed(await gate.signatureFor(call)).signer).toBe("pw-alice");
  });

  it("forgets a waiting request on request", async () => {
    const { clavis, gate } = setup();
    awaiting(await gate.signatureFor(call));
    await gate.forget(call);
    expect(awaiting(await gate.signatureFor(call)).fresh).toBe(true);
    expect(clavis.requests.size).toBe(2);
  });

  it("passes Clavis's refusal through and keeps nothing", async () => {
    const { clavis, gate, store } = setup();
    clavis.failRegistration(
      new AppClientError("register_failed", "register HTTP 402 SIGNATURE_CEILING", 402, { apiError: "SIGNATURE_CEILING" }),
    );
    await expect(gate.signatureFor(call)).rejects.toMatchObject({ code: "register_failed", apiError: "SIGNATURE_CEILING" });
    expect(clavis.requests.size).toBe(0);
    expect(await store.get((await prepareCall(call)).key)).toBeUndefined();
  });

  it("sends the return URL when one is set", async () => {
    const { clavis, gate } = setup({ returnUrl: "https://console.example/signed" });
    await gate.signatureFor(call);
    expect(clavis.last().input.returnUrl).toBe("https://console.example/signed");
  });
});

describe("createSignatureGate", () => {
  it("builds on the real clock", async () => {
    const clavis = fakeClavis();
    const gate = createSignatureGate({ app: clavis.app, store: memoryStore() });
    const before = Math.floor(Date.now() / 1000);
    expect(awaiting(await gate.signatureFor(call)).expiresAt).toBeGreaterThanOrEqual(before + 300);
  });

  it("refuses options Clavis would not take", () => {
    const { app } = fakeClavis();
    const store = memoryStore();
    for (const options of [
      { ttlSeconds: 59 },
      { ttlSeconds: 901 },
      { ttlSeconds: 120.5 },
      { pollIntervalMs: 1_000 },
      { returnUrl: "http://console.example/signed" },
      { returnUrl: "/signed" },
    ]) {
      expect(() => createSignatureGate({ app, store, ...options })).toThrow(/ttlSeconds|pollIntervalMs|returnUrl/);
    }
    expect(() => createSignatureGate({ app, store: undefined as unknown as SignatureStore })).toThrow(/store required/);
  });
});
