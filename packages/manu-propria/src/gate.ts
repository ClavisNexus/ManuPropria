import type { AppClient, AppReceipt, IntentStatusCompleted } from "@clavis.nexus/app";
import { callDocument, messageDigestOf, prepareCall, type Call, type CallDocument, type PreparedCall } from "./call.js";
import { SignatureGateError } from "./errors.js";
import type { PendingSignature, SignatureStore } from "./store.js";

/** What a signed call leaves behind. Keep it with the operation's record; `verifySignedCall` checks it later. */
export type SignedCall = {
  /** What the person signed (the document behind `messageDigest`). */
  document: CallDocument;
  messageDigest: string;
  requestId: string;
  /** The person, as your app knows them in Clavis. */
  signer: string;
  /** When they signed (Unix seconds). */
  signedAt: number;
  /** The receipt Clavis countersigned (`receipt.app@1`). */
  receipt: AppReceipt;
};

export type SignatureOutcome =
  /** Signed, verified and claimed for this run. Run the operation now, once. */
  | { state: "signed"; signature: SignedCall }
  /**
   * Not signed yet. The person signs at `url`. Ask again for the same call to pick the request up;
   * `fresh` is true when this answer opened the request, so the person has not seen `url` yet.
   */
  | {
      state: "awaiting";
      url: string;
      requestId: string;
      /** Until when the person can start signing (Unix seconds). */
      expiresAt: number;
      /** The person has opened the request on Connect. */
      started: boolean;
      fresh: boolean;
      /** The line Connect shows. */
      show: string;
    }
  /** The request lapsed without a signature. Nothing ran. Asking again opens a new request. */
  | { state: "expired"; show: string };

export type SignatureGateOptions = {
  /** A client from `createAppClient` (`@clavis.nexus/app` 2.1 or later). */
  app: Pick<AppClient, "registerGenericSign" | "getStatus">;
  store: SignatureStore;
  /**
   * How long the person has to start signing, in seconds (60–900). 300 by default, which is also the default
   * limit of an app; a longer value has to fit the limit set on the app.
   */
  ttlSeconds?: number;
  /**
   * Where Connect sends the person after they sign (https, under your app's confirmed host). Without it the
   * person finishes on Connect and goes back to wherever they were, such as the agent's window.
   */
  returnUrl?: string;
  /** Milliseconds between status reads while holding (2,000 or more; 2,500 by default). */
  pollIntervalMs?: number;
};

export type SignatureForOptions = {
  /**
   * When a request is already waiting, how long to wait for the signature before answering `awaiting`
   * (milliseconds). 0 by default. A request opened by this call answers at once: the person has to see the URL first.
   */
  holdMs?: number;
  signal?: AbortSignal;
};

export type SignatureGate = {
  /**
   * The signature for `call`: opens a request the first time, and picks the same request up on later calls
   * with the same call until it is signed, lapses or is forgotten.
   */
  signatureFor(call: Call, options?: SignatureForOptions): Promise<SignatureOutcome>;
  /** Drops the waiting request for `call` (for example after the person declines). Clavis lets it lapse. */
  forget(call: Call): Promise<void>;
};

const DEFAULT_TTL_SECONDS = 300;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 900;
/** How long Clavis keeps the result of a request whose signing has started (seconds after completion). */
const RESULT_WINDOW_SECONDS = 900;
const DEFAULT_POLL_INTERVAL_MS = 2_500;
/** Clavis lets an app read one request's status 30 times a minute. */
const MIN_POLL_INTERVAL_MS = 2_000;
const MAX_BACKOFF_MS = 15_000;

type Observation =
  | { kind: "waiting"; started: boolean }
  | { kind: "completed"; status: IntentStatusCompleted }
  | { kind: "expired" }
  | { kind: "rate_limited" };

function clientErrorStatus(error: unknown): number | undefined {
  // Duck-typed so a second copy of @clavis.nexus/app in the tree is still recognised
  const e = error as { name?: unknown; code?: unknown; status?: unknown } | null;
  if (e && e.name === "AppClientError" && e.code === "status_failed" && typeof e.status === "number") return e.status;
  return undefined;
}

/** Time and waiting, separated so tests can drive them. */
type Runtime = { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };

const realRuntime: Runtime = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

function checkOptions(options: SignatureGateOptions): { ttlSeconds: number; pollIntervalMs: number; returnUrl?: string } {
  if (!options || typeof options !== "object") throw new SignatureGateError("invalid_options", "options required");
  if (!options.app || typeof options.app.registerGenericSign !== "function" || typeof options.app.getStatus !== "function") {
    throw new SignatureGateError("invalid_options", "app must be a client from createAppClient");
  }
  if (!options.store) throw new SignatureGateError("invalid_options", "store required (memoryStore() for a single process)");
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    throw new SignatureGateError("invalid_options", `ttlSeconds must be an integer from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS}`);
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < MIN_POLL_INTERVAL_MS) {
    throw new SignatureGateError("invalid_options", `pollIntervalMs must be at least ${MIN_POLL_INTERVAL_MS}`);
  }
  if (options.returnUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(options.returnUrl);
    } catch {
      throw new SignatureGateError("invalid_options", "returnUrl must be an absolute https URL");
    }
    if (url.protocol !== "https:") throw new SignatureGateError("invalid_options", "returnUrl must be https");
  }
  return { ttlSeconds, pollIntervalMs, ...(options.returnUrl !== undefined ? { returnUrl: options.returnUrl } : {}) };
}

/**
 * A gate in front of operations that run only after a person signs them with their passkey.
 *
 * ```ts
 * const gate = createSignatureGate({ app, store: memoryStore() });
 * const outcome = await gate.signatureFor({ name, arguments: args, show, signer });
 * if (outcome.state === "signed") await run(args, outcome.signature);
 * ```
 */
export function createSignatureGate(options: SignatureGateOptions): SignatureGate {
  const runtime = (options as SignatureGateOptions & { runtime?: Runtime }).runtime ?? realRuntime;
  return gateWithRuntime(options, runtime);
}

function gateWithRuntime(options: SignatureGateOptions, runtime: Runtime): SignatureGate {
  const { ttlSeconds, pollIntervalMs, returnUrl } = checkOptions(options);
  const { app, store } = options;
  // A started signature can finish after the request lapses, and stays readable for the result window
  const recordTtl = ttlSeconds + RESULT_WINDOW_SECONDS + 60;
  const usedTtl = ttlSeconds + RESULT_WINDOW_SECONDS + 300;

  function awaiting(record: PendingSignature, started: boolean, fresh: boolean): SignatureOutcome {
    return {
      state: "awaiting",
      url: record.url,
      requestId: record.requestId,
      expiresAt: record.expiresAt,
      started,
      fresh,
      show: record.document.show,
    };
  }

  async function open(prepared: PreparedCall, signal?: AbortSignal): Promise<SignatureOutcome> {
    const document = callDocument(prepared, crypto.randomUUID());
    const messageDigest = await messageDigestOf(document);
    const expiresAt = Math.floor(runtime.now() / 1000) + ttlSeconds;
    const registration = await app.registerGenericSign({
      messageDigest,
      displayHint: document.show,
      allowedSub: document.signer,
      ttlSeconds,
      ...(returnUrl !== undefined ? { returnUrl } : {}),
      ...(prepared.uiLocales !== undefined ? { uiLocales: prepared.uiLocales } : {}),
      ...(signal ? { signal } : {}),
    });
    const record: PendingSignature = {
      v: 1,
      key: prepared.key,
      requestId: registration.requestId,
      pollSecret: registration.pollSecret,
      url: registration.consumeUrl,
      document,
      messageDigest,
      expiresAt,
    };
    await store.set(prepared.key, record, recordTtl);
    return awaiting(record, false, true);
  }

  async function observe(record: PendingSignature, signal?: AbortSignal): Promise<Observation> {
    try {
      const status = await app.getStatus(record.requestId, record.pollSecret, record.messageDigest, signal ? { signal } : undefined);
      if (status.state === "completed") return { kind: "completed", status };
      return { kind: "waiting", started: status.state === "intent_issued" };
    } catch (e) {
      signal?.throwIfAborted();
      const status = clientErrorStatus(e);
      if (status === 404) return { kind: "expired" };
      if (status === 429) return { kind: "rate_limited" };
      throw e;
    }
  }

  /** The completion, checked against the call: Clavis already checked the digest and the countersignature. */
  function signedCall(record: PendingSignature, status: IntentStatusCompleted): SignedCall {
    if (status.sub !== record.document.signer) {
      throw new SignatureGateError("receipt_mismatch", "the receipt names a different signer than the request");
    }
    const shown = status.receipt.envelope.ext?.["shown@1"] as { action?: unknown } | undefined;
    if (shown?.action !== record.document.show) {
      throw new SignatureGateError("receipt_mismatch", "the receipt shows a different line than the call");
    }
    return {
      document: record.document,
      messageDigest: record.messageDigest,
      requestId: record.requestId,
      signer: status.sub,
      signedAt: status.signedAt,
      receipt: status.receipt,
    };
  }

  async function forgetIfCurrent(key: string, requestId: string): Promise<void> {
    const current = await store.get(key);
    if (current?.requestId === requestId) await store.delete(key);
  }

  async function signatureFor(call: Call, opts: SignatureForOptions = {}): Promise<SignatureOutcome> {
    const prepared = await prepareCall(call);
    const { signal } = opts;
    signal?.throwIfAborted();
    const record = await store.get(prepared.key);
    if (!record) return open(prepared, signal);

    const deadline = runtime.now() + Math.max(0, opts.holdMs ?? 0);
    let pause = pollIntervalMs;
    let started = false;
    for (;;) {
      const seen = await observe(record, signal);
      if (seen.kind === "completed") {
        let signature: SignedCall;
        try {
          signature = signedCall(record, seen.status);
        } catch (e) {
          // Do not keep a request whose completion cannot run; the next call opens a new one
          await forgetIfCurrent(prepared.key, record.requestId);
          throw e;
        }
        // One signature authorizes one run. If it has run already, this call needs its own.
        if (!(await store.use(record.requestId, usedTtl))) return open(prepared, signal);
        return { state: "signed", signature };
      }
      if (seen.kind === "expired") {
        await forgetIfCurrent(prepared.key, record.requestId);
        return { state: "expired", show: prepared.show };
      }
      if (seen.kind === "waiting") {
        started = seen.started;
        pause = pollIntervalMs;
      } else {
        pause = Math.min(pause * 2, MAX_BACKOFF_MS);
      }
      if (runtime.now() + pause > deadline) return awaiting(record, started, false);
      await runtime.sleep(pause, signal);
    }
  }

  async function forget(call: Call): Promise<void> {
    const prepared = await prepareCall(call);
    await store.delete(prepared.key);
  }

  return { signatureFor, forget };
}
