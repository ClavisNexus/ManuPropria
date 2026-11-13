import { AppClientError, type VerifyReceiptOptions } from "@clavis.nexus/app";
import { describe, expect, it } from "vitest";
import { callDocument, messageDigestOf, prepareCall, type Call } from "./call.js";
import type { SignedCall } from "./gate.js";
import { APP_ID, appReceipt, fakeVerifier, receiptKey } from "./test-support/fake-clavis.js";
import { verifySignedCall } from "./verify.js";

const call: Call = {
  name: "refund",
  arguments: { orderId: "1042", amount: 120 },
  show: "Refund $120.00 on order 1042",
  signer: "pw-alice",
};

async function kept(overrides: { action?: string; signer?: string; type?: string; request?: string } = {}) {
  const key = await receiptKey();
  const document = callDocument(await prepareCall(call), crypto.randomUUID());
  const messageDigest = await messageDigestOf(document);
  const requestId = crypto.randomUUID();
  const signedAt = 1_791_747_759;
  const receipt = await appReceipt({
    digest: messageDigest,
    signer: overrides.signer ?? document.signer,
    action: overrides.action ?? document.show,
    request: overrides.request ?? requestId,
    iat: signedAt,
    key,
    ...(overrides.type !== undefined ? { type: overrides.type } : {}),
  });
  const signed: SignedCall = { document, messageDigest, requestId, signer: document.signer, signedAt, receipt };
  return { signed, verifier: fakeVerifier(key) };
}

describe("verifySignedCall", () => {
  it("accepts a kept call whose document, digest, line, signer and countersignature agree", async () => {
    const { signed, verifier } = await kept();
    const stored = JSON.parse(JSON.stringify(signed)) as unknown;
    const result = await verifySignedCall(stored, { verifier, appId: APP_ID });
    expect(result).toEqual({ ok: true, signature: signed });
    // The receipt goes to the verifier as the string that was kept, bound to the request
    expect(verifier.reads).toEqual([{ expect: { aud: `request:${signed.requestId}` }, anchor: "skip" }]);
  });

  it("refuses a document changed after signing", async () => {
    const { signed, verifier } = await kept();
    const tampered = { ...signed, document: { ...signed.document, arguments: { orderId: "1042", amount: 1200 } } };
    expect(await verifySignedCall(tampered, { verifier })).toEqual({ ok: false, reason: "digest" });
  });

  it("refuses a receipt for another line or another signer", async () => {
    const otherLine = await kept({ action: "Refund $1.00 on order 1042" });
    expect(await verifySignedCall(otherLine.signed, { verifier: otherLine.verifier })).toEqual({ ok: false, reason: "shown" });
    const otherSigner = await kept({ signer: "pw-mallory" });
    expect(await verifySignedCall(otherSigner.signed, { verifier: otherSigner.verifier })).toEqual({
      ok: false,
      reason: "signer",
    });
  });

  it("refuses a record whose time differs from the receipt's", async () => {
    const { signed, verifier } = await kept();
    expect(await verifySignedCall({ ...signed, signedAt: signed.signedAt + 1 }, { verifier })).toEqual({
      ok: false,
      reason: "signed_at",
    });
  });

  it("refuses a receipt for another statement", async () => {
    const { signed, verifier } = await kept({ type: "app.sign.on_behalf@1" });
    expect(await verifySignedCall(signed, { verifier })).toEqual({ ok: false, reason: "digest" });
  });

  it("refuses a receipt Clavis did not countersign, one for another request, or one for another app", async () => {
    const { signed } = await kept();
    const stranger = fakeVerifier(await receiptKey("another-key"));
    expect(await verifySignedCall(signed, { verifier: stranger })).toEqual({
      ok: false,
      reason: "receipt",
      detail: "accepted_kid",
    });
    const moved = await kept({ request: crypto.randomUUID() });
    expect(await verifySignedCall(moved.signed, { verifier: moved.verifier })).toEqual({
      ok: false,
      reason: "receipt",
      detail: "expect_aud",
    });
    const { signed: mine, verifier } = await kept();
    expect(await verifySignedCall(mine, { verifier, appId: "another-app" })).toEqual({
      ok: false,
      reason: "receipt",
      detail: "app",
    });
  });

  it("refuses a holder receipt", async () => {
    const { signed, verifier } = await kept();
    const holder = {
      verifyReceipt: async (receipt: string, options?: VerifyReceiptOptions) => ({
        ...(await verifier.verifyReceipt(receipt, options)),
        type: "receipt@1" as const,
      }),
    };
    expect(await verifySignedCall(signed, { verifier: holder })).toEqual({ ok: false, reason: "receipt", detail: "type" });
  });

  it("throws when the verifier cannot answer, instead of refusing the record", async () => {
    const { signed } = await kept();
    const unreachable = {
      verifyReceipt: async () => {
        throw new AppClientError("trust_unavailable", "the trust documents cannot be read");
      },
    };
    await expect(verifySignedCall(signed, { verifier: unreachable })).rejects.toMatchObject({ code: "trust_unavailable" });
  });

  it("refuses anything that is not a signed call", async () => {
    const { signed, verifier } = await kept();
    for (const value of [null, "receipt", {}, { messageDigest: "x" }, { ...signed, receipt: JSON.parse(signed.receipt) }, { ...signed, receipt: "" }]) {
      expect(await verifySignedCall(value, { verifier })).toEqual({ ok: false, reason: "shape" });
    }
    expect(verifier.reads).toEqual([]);
  });
});
