/**
 * An in-process stand-in for the Clavis API, shaped like `createAppClient` from `@clavis.nexus/app`.
 * The person's side (opening Connect, signing) is driven by the test.
 */
import {
  AppClientError,
  type AppClient,
  type ReceiptAnchor,
  type ReceiptEnvelope,
  type RegisterGenericSignInput,
  type VerifiedReceipt,
  type Verifier,
  type VerifyReceiptOptions,
} from "@clavis.nexus/app";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { canonicalJson } from "../json.js";

export const APP_ID = "550e8400-e29b-41d4-a716-446655440000";
export const RECEIPT_KID = "clavis-sign-receipt";

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function digestOf(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return `sha256:${b64u(new Uint8Array(hash))}`;
}

export type ReceiptKey = { privateJwk: JWK; publicJwk: JWK };

export async function receiptKey(kid = RECEIPT_KID): Promise<ReceiptKey> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = (await exportJWK(pair.privateKey)) as JWK;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256" };
  privateJwk.kid = kid;
  privateJwk.alg = "ES256";
  return { privateJwk, publicJwk };
}

type ReceiptBody = {
  type: "receipt.app@1";
  statement: { type: string; request: string; app: string; digest: string };
  envelope: ReceiptEnvelope;
  proof: string;
  dimension: { type: string; name: string };
};

type ReceiptJson = ReceiptBody & { attestations: { type: "accepted@1"; at: number; kid: string; alg: "ES256"; sig: string }[] };

/**
 * A `receipt.app@1` string shaped like Clavis's, countersigned with `key` over the canonical body. The real one is
 * checked by the Collatio verifier against Clavis's trust documents; `fakeVerifier` checks this one with `key`.
 */
export async function appReceipt(input: {
  digest: string;
  signer: string;
  action: string;
  request: string;
  key: ReceiptKey;
  iat?: number;
  app?: string;
  type?: string;
}): Promise<string> {
  const iat = input.iat ?? 1_791_747_759;
  const statement = { type: input.type ?? "app.sign@1", request: input.request, app: input.app ?? APP_ID, digest: input.digest };
  const body: ReceiptBody = {
    type: "receipt.app@1",
    statement,
    envelope: {
      suite: "webauthn@1",
      dimension: `sha256:${"D".repeat(43)}`,
      aud: `request:${input.request}`,
      statement: await digestOf(statement),
      signer: input.signer,
      rp: "clavis.nexus",
      iat,
      nonce: "N".repeat(43),
      ext: { "shown@1": { app: "Northwind", host: "app.northwind.example", action: input.action } },
      crit: ["shown@1"],
    },
    proof: `sha256:${"P".repeat(43)}`,
    dimension: { type: "dimension@1", name: "app_sign" },
  };
  const key = await crypto.subtle.importKey("jwk", input.key.privateJwk as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(canonicalJson(body)));
  const receipt: ReceiptJson = {
    ...body,
    attestations: [{ type: "accepted@1", at: iat + 2, kid: input.key.publicJwk.kid ?? RECEIPT_KID, alg: "ES256", sig: b64u(new Uint8Array(sig)) }],
  };
  return JSON.stringify(receipt);
}

const ANCHOR: ReceiptAnchor = {
  log: "clavis.nexus/ledger/first-party.3",
  index: 0,
  origin: "https://trust.clavis.test",
  leafHash: "L".repeat(43),
  state: "anchored",
  size: 1,
  time: 1_791_747_800,
};

function refused(reason: string): AppClientError {
  return new AppClientError("receipt_invalid", `the receipt was refused by the verifier (${reason})`, undefined, { verifierReason: reason });
}

/**
 * A stand-in for the verifier of `@clavis.nexus/app`: it accepts receipts countersigned with `key`, refuses the rest
 * as the real verifier does (`receipt_invalid` with `verifierReason`), and answers as `verifyReceipt` does.
 */
export function fakeVerifier(keyOf: ReceiptKey | Promise<ReceiptKey>): Pick<Verifier, "verifyReceipt"> & { reads: VerifyReceiptOptions[] } {
  const reads: VerifyReceiptOptions[] = [];
  return {
    reads,
    async verifyReceipt(receipt, options = {}) {
      reads.push(options);
      const key = await keyOf;
      let parsed: ReceiptJson;
      try {
        parsed = JSON.parse(receipt) as ReceiptJson;
      } catch {
        throw refused("json");
      }
      const { attestations, ...body } = parsed;
      const accepted = attestations?.[0];
      if (!accepted || accepted.kid !== key.publicJwk.kid) throw refused("accepted_kid");
      const publicKey = await crypto.subtle.importKey("jwk", key.publicJwk as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "verify",
      ]);
      const ok = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        fromB64u(accepted.sig),
        new TextEncoder().encode(canonicalJson(body)),
      );
      if (!ok) throw refused("accepted_sig");
      if (options.expect?.aud !== undefined && body.envelope.aud !== options.expect.aud) throw refused("expect_aud");
      const verified: VerifiedReceipt = {
        receipt,
        type: body.type,
        statement: body.statement,
        envelope: body.envelope,
        dimension: { digest: body.envelope.dimension, name: body.dimension.name, verifier: `sha256:${"V".repeat(43)}`, registry: `sha256:${"R".repeat(43)}`, signer: "pairwise" },
        accepted: [{ kid: accepted.kid, at: accepted.at }],
        anchor: { ...ANCHOR, state: "unanchored", reason: "skipped" },
        verifier: `sha256:${"V".repeat(43)}`,
        catalogStale: false,
      };
      return verified;
    },
  };
}

export type FakeRequest = {
  requestId: string;
  pollSecret: string;
  input: RegisterGenericSignInput;
  state: "pending" | "intent_issued" | "completed" | "expired";
  signedBy?: string;
  shownAction?: string;
  statusReads: number;
};

function statusError(status: number, apiError: string): AppClientError {
  return new AppClientError("status_failed", `status HTTP ${status} ${apiError}`, status, { apiError });
}

export function fakeClavis() {
  const requests = new Map<string, FakeRequest>();
  let rateLimited = 0;
  let registerError: AppClientError | undefined;
  let onStatusRead: ((request: FakeRequest) => void) | undefined;
  // Clavis's receipt key, made once per fake
  const key = receiptKey();
  const verifier = fakeVerifier(key);

  const app: Pick<AppClient, "registerGenericSign" | "getStatus"> & { verifier: typeof verifier } = {
    verifier,
    async registerGenericSign(input) {
      if (registerError) throw registerError;
      const requestId = crypto.randomUUID();
      const request: FakeRequest = { requestId, pollSecret: `poll-${requestId}`, input, state: "pending", statusReads: 0 };
      requests.set(requestId, request);
      return {
        requestId,
        pollSecret: request.pollSecret,
        consumeUrl: `https://api.clavis.test/app/intent-requests/consume/${requestId}`,
      };
    },
    async getStatus(requestId, pollSecret, expectedMessageDigest) {
      const request = requests.get(requestId);
      if (!request || request.state === "expired") throw statusError(404, "NOT_FOUND");
      if (request.pollSecret !== pollSecret) throw statusError(403, "FORBIDDEN");
      if (rateLimited > 0) {
        rateLimited -= 1;
        throw statusError(429, "RATE_LIMITED");
      }
      request.statusReads += 1;
      onStatusRead?.(request);
      if (request.state === "pending") return { state: "pending" };
      if (request.state === "intent_issued") return { state: "intent_issued", intentType: "generic_sign" };
      const digest = request.input.messageDigest;
      if (digest !== expectedMessageDigest) {
        throw new AppClientError("digest_mismatch", "attested message_digest does not match registration digest");
      }
      const signer = request.signedBy ?? request.input.allowedSub ?? "anyone";
      const iat = 1_791_747_759;
      const action = request.shownAction ?? request.input.displayHint ?? "";
      const receipt = await appReceipt({ digest, signer, action, request: requestId, iat, key: await key });
      // The client reads these from the verifier's answer for that receipt
      return {
        state: "completed",
        intentType: "generic_sign",
        statementType: "app.sign@1",
        messageDigest: digest,
        sub: signer,
        signedAt: iat,
        receipt,
        anchor: ANCHOR,
      };
    },
  };

  function only(): FakeRequest {
    const all = [...requests.values()];
    const last = all.at(-1);
    if (!last) throw new Error("no request registered");
    return last;
  }

  return {
    app,
    requests,
    /** The most recent request. */
    last: only,
    /** The person opens the request on Connect. */
    start(request = only()) {
      request.state = "intent_issued";
    },
    /** The person signs. */
    sign(request = only(), as?: { signer?: string; shownAction?: string }) {
      request.state = "completed";
      if (as?.signer !== undefined) request.signedBy = as.signer;
      if (as?.shownAction !== undefined) request.shownAction = as.shownAction;
    },
    expire(request = only()) {
      request.state = "expired";
    },
    rateLimitNext(times: number) {
      rateLimited = times;
    },
    failRegistration(error: AppClientError | undefined) {
      registerError = error;
    },
    /** Runs on every status read that is not refused, before the answer. */
    whenStatusRead(callback: ((request: FakeRequest) => void) | undefined) {
      onStatusRead = callback;
    },
  };
}
