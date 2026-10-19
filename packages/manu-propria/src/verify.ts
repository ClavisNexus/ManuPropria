import { parseAppReceipt, verifyAppReceipt } from "@clavis.nexus/app";
import { isCallDocument, messageDigestOf } from "./call.js";
import type { SignedCall } from "./gate.js";

/** Receipt keys from Clavis's JWKS: `receiptKeysFromJwksDocument(jwks)` after `verifySignedJwksDocument`. */
export type ReceiptKeys = Parameters<typeof verifyAppReceipt>[1];

export type VerifySignedCallOptions = {
  receiptKeys: ReceiptKeys;
  /** Your app's ID. When given, the receipt must be for this app. */
  appId?: string;
};

export type VerifySignedCallFailure =
  /** Not a signed call, or its receipt is not a receipt. */
  | "shape"
  /** The document is not a version 1 call document. */
  | "document"
  /** The document does not hash to the digest, or the receipt is for another digest. */
  | "digest"
  /** The receipt, the document and the record name different signers. */
  | "signer"
  /** Connect showed another line than the document's. */
  | "shown"
  | "signed_at"
  /** The receipt itself failed (its countersignature, its rules or its app); `detail` says which. */
  | "receipt";

export type VerifySignedCallResult =
  | { ok: true; signature: SignedCall }
  | { ok: false; reason: VerifySignedCallFailure; detail?: string };

const DIGEST = /^[A-Za-z0-9_-]{43}$/;

/**
 * Checks a kept signed call without asking Clavis: the document hashes to the signed digest, the receipt names
 * the same signer and the same line, and Clavis countersigned the receipt. It does not check freshness or
 * whether the call ran; those belong to your records.
 */
export async function verifySignedCall(value: unknown, options: VerifySignedCallOptions): Promise<VerifySignedCallResult> {
  const v = value as Partial<SignedCall> | null;
  if (
    v === null ||
    typeof v !== "object" ||
    typeof v.messageDigest !== "string" ||
    !DIGEST.test(v.messageDigest) ||
    typeof v.requestId !== "string" ||
    typeof v.signer !== "string" ||
    typeof v.signedAt !== "number"
  ) {
    return { ok: false, reason: "shape" };
  }
  const receipt = parseAppReceipt(v.receipt);
  if (!receipt) return { ok: false, reason: "shape" };
  if (!isCallDocument(v.document)) return { ok: false, reason: "document" };
  const document = v.document;

  if ((await messageDigestOf(document)) !== v.messageDigest) return { ok: false, reason: "digest" };
  if (receipt.statement.type !== "app.sign@1" || receipt.statement.digest !== v.messageDigest) {
    return { ok: false, reason: "digest" };
  }
  if (receipt.envelope.signer !== document.signer || v.signer !== document.signer) return { ok: false, reason: "signer" };
  const shown = receipt.envelope.ext?.["shown@1"] as { action?: unknown } | undefined;
  if (shown?.action !== document.show) return { ok: false, reason: "shown" };
  if (receipt.envelope.iat !== v.signedAt) return { ok: false, reason: "signed_at" };

  const countersigned = await verifyAppReceipt(
    receipt,
    options.receiptKeys,
    options.appId !== undefined ? { expectedApp: options.appId } : undefined,
  );
  if (!countersigned.ok) return { ok: false, reason: "receipt", detail: countersigned.reason };

  return {
    ok: true,
    signature: {
      document,
      messageDigest: v.messageDigest,
      requestId: v.requestId,
      signer: v.signer,
      signedAt: v.signedAt,
      receipt,
    },
  };
}
