import { describe, expect, it } from "vitest";
import { callDocument, messageDigestOf, prepareCall, type Call } from "./call.js";
import type { SignedCall } from "./gate.js";
import { APP_ID, appReceipt, receiptKey } from "./test-support/fake-clavis.js";
import { verifySignedCall } from "./verify.js";

const call: Call = {
  name: "refund",
  arguments: { orderId: "1042", amount: 120 },
  show: "Refund $120.00 on order 1042",
  signer: "pw-alice",
};

async function kept(overrides: { action?: string; signer?: string } = {}) {
  const key = await receiptKey();
  const document = callDocument(await prepareCall(call), crypto.randomUUID());
  const messageDigest = await messageDigestOf(document);
  const receipt = await appReceipt({
    digest: messageDigest,
    signer: overrides.signer ?? document.signer,
    action: overrides.action ?? document.show,
    key,
  });
  const signed: SignedCall = {
    document,
    messageDigest,
    requestId: crypto.randomUUID(),
    signer: document.signer,
    signedAt: receipt.envelope.iat,
    receipt,
  };
  return { signed, keys: key.keys };
}

describe("verifySignedCall", () => {
  it("accepts a kept call whose document, digest, line, signer and countersignature agree", async () => {
    const { signed, keys } = await kept();
    const stored = JSON.parse(JSON.stringify(signed)) as unknown;
    const result = await verifySignedCall(stored, { receiptKeys: keys, appId: APP_ID });
    expect(result).toEqual({ ok: true, signature: signed });
  });

  it("refuses a document changed after signing", async () => {
    const { signed, keys } = await kept();
    const tampered = { ...signed, document: { ...signed.document, arguments: { orderId: "1042", amount: 1200 } } };
    expect(await verifySignedCall(tampered, { receiptKeys: keys })).toEqual({ ok: false, reason: "digest" });
  });

  it("refuses a receipt for another line or another signer", async () => {
    const otherLine = await kept({ action: "Refund $1.00 on order 1042" });
    expect(await verifySignedCall(otherLine.signed, { receiptKeys: otherLine.keys })).toEqual({ ok: false, reason: "shown" });
    const otherSigner = await kept({ signer: "pw-mallory" });
    expect(await verifySignedCall(otherSigner.signed, { receiptKeys: otherSigner.keys })).toEqual({
      ok: false,
      reason: "signer",
    });
  });

  it("refuses a receipt Clavis did not countersign, or one for another app", async () => {
    const { signed } = await kept();
    const stranger = await receiptKey();
    expect(await verifySignedCall(signed, { receiptKeys: stranger.keys })).toEqual({
      ok: false,
      reason: "receipt",
      detail: "receipt_signature",
    });
    const { signed: mine, keys } = await kept();
    expect(await verifySignedCall(mine, { receiptKeys: keys, appId: "another-app" })).toEqual({
      ok: false,
      reason: "receipt",
      detail: "app",
    });
  });

  it("refuses anything that is not a signed call", async () => {
    const { keys } = await kept();
    for (const value of [null, "receipt", {}, { messageDigest: "x" }]) {
      expect(await verifySignedCall(value, { receiptKeys: keys })).toEqual({ ok: false, reason: "shape" });
    }
  });
});
