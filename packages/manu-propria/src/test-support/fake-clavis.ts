/**
 * An in-process stand-in for the Clavis API, shaped like `createAppClient` from `@clavis.nexus/app`.
 * The person's side (opening Connect, signing) is driven by the test.
 */
import { AppClientError, type AppClient, type AppReceipt, type RegisterGenericSignInput } from "@clavis.nexus/app";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { canonicalJson } from "../json.js";

export const APP_ID = "550e8400-e29b-41d4-a716-446655440000";
export const RECEIPT_KID = "clavis-sign-receipt";

export const APP_DIMENSION = {
  type: "dimension@1",
  name: "app",
  statements: ["app.sign@1"],
  suites: ["webauthn@1"],
  signer: "pairwise",
  sessions: ["app", "portal"],
  rp: "platform",
  freshness: 600,
  single_use: true,
  ext: { required: ["shown@1"], allowed: ["shown@1"] },
  receipts: ["app", "holder"],
  key_log: false,
};

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function digestOf(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return `sha256:${b64u(new Uint8Array(hash))}`;
}

export type ReceiptKey = { privateJwk: JWK; publicJwk: JWK; keys: Map<string, JWK> };

export async function receiptKey(kid = RECEIPT_KID): Promise<ReceiptKey> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = (await exportJWK(pair.privateKey)) as JWK;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256" };
  privateJwk.kid = kid;
  privateJwk.alg = "ES256";
  return { privateJwk, publicJwk, keys: new Map([[kid, publicJwk]]) };
}

/** A `receipt.app@1` shaped like Clavis's, countersigned with `key` when one is given. */
export async function appReceipt(input: {
  digest: string;
  signer: string;
  action: string;
  iat?: number;
  app?: string;
  key?: ReceiptKey;
}): Promise<AppReceipt> {
  const statement = { type: "app.sign@1", app: input.app ?? APP_ID, digest: input.digest };
  const body = {
    type: "receipt.app@1" as const,
    statement,
    envelope: {
      suite: "webauthn@1",
      dimension: await digestOf(APP_DIMENSION),
      aud: `app:${statement.app}`,
      statement: await digestOf(statement),
      signer: input.signer,
      rp: "clavis.nexus",
      iat: input.iat ?? 1_791_747_759,
      nonce: "N".repeat(43),
      ext: { "shown@1": { app: "Northwind", host: "app.northwind.example", action: input.action } },
      crit: ["shown@1"],
    },
    proof: `sha256:${"P".repeat(43)}`,
    dimension: APP_DIMENSION,
    accepted_at: (input.iat ?? 1_791_747_759) + 2,
  };
  if (!input.key) return { ...body, sigs: [{ kid: RECEIPT_KID, alg: "ES256", sig: "S".repeat(86) }] };
  const key = await crypto.subtle.importKey(
    "jwk",
    input.key.privateJwk as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(canonicalJson(body)));
  return { ...body, sigs: [{ kid: input.key.publicJwk.kid ?? RECEIPT_KID, alg: "ES256", sig: b64u(new Uint8Array(sig)) }] };
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

  const app: Pick<AppClient, "registerGenericSign" | "getStatus"> = {
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
      const receipt = await appReceipt({ digest, signer, action: request.shownAction ?? request.input.displayHint ?? "" });
      return {
        state: "completed",
        intentType: "generic_sign",
        statementType: "app.sign@1",
        messageDigest: digest,
        sub: signer,
        signedAt: receipt.envelope.iat,
        receipt,
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
