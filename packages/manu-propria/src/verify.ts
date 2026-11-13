import type { Verifier } from "@clavis.nexus/app";
import { isCallDocument, messageDigestOf } from "./call.js";
import type { SignedCall } from "./gate.js";

export type VerifySignedCallOptions = {
  /**
   * The verifier of `@clavis.nexus/app`: `createVerifier({ trustRoot, apiOrigin })`, or `app.verifier` of a client
   * from `createAppClient`.
   */
  verifier: Pick<Verifier, "verifyReceipt">;
  /** Your app's ID. When given, the receipt must be for this app. */
  appId?: string;
};

export type VerifySignedCallFailure =
  /** Not a signed call, or its receipt is not a string. */
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
  /**
   * The receipt itself failed: the verifier refused it (`detail` is the verifier's reason), it is not an app
   * receipt (`type`), or it is for another app (`app`).
   */
  | "receipt";

export type VerifySignedCallResult =
  | { ok: true; signature: SignedCall }
  | { ok: false; reason: VerifySignedCallFailure; detail?: string };

const DIGEST = /^[A-Za-z0-9_-]{43}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The verifier's refusal of the receipt, told apart from a verifier that could not answer. */
function refusalReason(error: unknown): string | undefined {
  // Duck-typed so a second copy of @clavis.nexus/app in the tree is still recognised
  const e = error as { name?: unknown; code?: unknown; verifierReason?: unknown } | null;
  if (e?.name !== "AppClientError" || e.code !== "receipt_invalid") return undefined;
  return typeof e.verifierReason === "string" ? e.verifierReason : "receipt_invalid";
}

/**
 * Checks a kept signed call: the document hashes to the signed digest, the verifier accepts the receipt as an app
 * receipt for that request, and the receipt names the same signer and the same line. It does not check freshness or
 * whether the call ran; those belong to your records. The verifier reads Clavis's trust documents from the trust
 * surface; the ledger's inclusion proof is not fetched.
 *
 * A verifier that cannot answer (the trust surface unreachable, for example) throws its `AppClientError`.
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
    typeof v.signedAt !== "number" ||
    typeof v.receipt !== "string" ||
    v.receipt.length === 0
  ) {
    return { ok: false, reason: "shape" };
  }
  if (!isCallDocument(v.document)) return { ok: false, reason: "document" };
  const document = v.document;
  if ((await messageDigestOf(document)) !== v.messageDigest) return { ok: false, reason: "digest" };

  let verified: Awaited<ReturnType<Verifier["verifyReceipt"]>>;
  try {
    verified = await options.verifier.verifyReceipt(v.receipt, { expect: { aud: `request:${v.requestId}` }, anchor: "skip" });
  } catch (e) {
    const reason = refusalReason(e);
    if (reason === undefined) throw e;
    return { ok: false, reason: "receipt", detail: reason };
  }
  if (verified.type !== "receipt.app@1") return { ok: false, reason: "receipt", detail: "type" };
  const { statement, envelope } = verified;
  if (options.appId !== undefined && statement.app !== options.appId) return { ok: false, reason: "receipt", detail: "app" };
  if (statement.type !== "app.sign@1" || statement.digest !== v.messageDigest) return { ok: false, reason: "digest" };
  if (envelope.signer !== document.signer || v.signer !== document.signer) return { ok: false, reason: "signer" };
  const shown = asRecord(asRecord(envelope.ext)?.["shown@1"]);
  if (shown?.action !== document.show) return { ok: false, reason: "shown" };
  if (envelope.iat !== v.signedAt) return { ok: false, reason: "signed_at" };

  return {
    ok: true,
    signature: {
      document,
      messageDigest: v.messageDigest,
      requestId: v.requestId,
      signer: v.signer,
      signedAt: v.signedAt,
      receipt: v.receipt,
    },
  };
}
