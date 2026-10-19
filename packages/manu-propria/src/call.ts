import { SignatureGateError } from "./errors.js";
import { canonicalJson, isJsonObject, sha256Base64Url, type JsonObject } from "./json.js";
import { normalizeShow, SHOW_MAX_LENGTH } from "./show.js";

/** The type of the document a person signs. Frozen: a change of shape gets a new version, never a new meaning. */
export const CALL_TYPE = "manu_propria.call@1";

/** The largest call document a signature request carries (UTF-8 bytes of its canonical form). */
export const CALL_MAX_BYTES = 256 * 1024;

const NAME_MAX_LENGTH = 200;
const SIGNER_MAX_LENGTH = 256;
// C0 and C1 controls, which no operation name needs
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/**
 * Controls that can make the line read differently from what it contains: C0/C1 controls, and the bidirectional
 * embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069) used to reorder text in front of a reader.
 */
const UNSAFE_IN_SHOW = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** What an agent, a tool or a job asks to run, and who has to sign it before it does. */
export type Call = {
  /** The operation: a tool name, a job name. */
  name: string;
  /** The operation's arguments, exactly as the operation will receive them. */
  arguments: JsonObject;
  /**
   * The line the person reads on Connect before signing, written for them: what will happen, to what.
   * Up to 500 characters after Connect's normalization. It becomes part of what they sign.
   */
  show: string;
  /**
   * The person who signs, as your app knows them in Clavis: the OIDC `sub`, or the `sub` of an earlier completion.
   * Nobody else's passkey can sign the request.
   */
  signer: string;
  /** Where the call came from, when that matters to whoever reads the record later. Bound, not shown. */
  context?: JsonObject;
  /** The languages of the person's screen, in order of preference (BCP 47). Connect shows its page in the first it has. */
  uiLocales?: readonly string[];
};

/**
 * The document behind `message_digest`: `message_digest = Base64URL(SHA-256(RFC 8785 canonical form))`.
 * Keep it with the receipt. Anyone holding both can recompute the digest and check it against the receipt.
 */
export type CallDocument = {
  type: typeof CALL_TYPE;
  /** Unique per signature request, so one signature authorizes one run. */
  id: string;
  name: string;
  arguments: JsonObject;
  /** The normalized line, identical to `shown@1.action` in the receipt. */
  show: string;
  signer: string;
  context?: JsonObject;
};

/** A call checked and normalized, with the key that finds its pending request again. */
export type PreparedCall = {
  name: string;
  arguments: JsonObject;
  show: string;
  signer: string;
  context?: JsonObject;
  uiLocales?: readonly string[];
  key: string;
};

function invalid(message: string): never {
  throw new SignatureGateError("invalid_call", message);
}

function assertJsonObject(value: unknown, field: string): asserts value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be a plain JSON object`);
  try {
    canonicalJson(value);
  } catch (e) {
    invalid(`${field} must be a plain JSON object: ${(e as Error).message}`);
  }
}

/**
 * Checks a call and computes its key. The same name, arguments, line, signer and context give the same key,
 * so asking again for the same call finds the request already waiting for the person.
 */
export async function prepareCall(call: Call): Promise<PreparedCall> {
  if (call === null || typeof call !== "object") invalid("call must be an object");
  const { name, arguments: args, signer, context, uiLocales } = call;
  if (typeof name !== "string" || name.length === 0 || name.length > NAME_MAX_LENGTH || CONTROL.test(name)) {
    invalid(`name must be 1 to ${NAME_MAX_LENGTH} characters without control characters`);
  }
  if (!name.isWellFormed()) invalid("name contains a lone surrogate");
  assertJsonObject(args, "arguments");
  const show = normalizeShow(call.show);
  if (show === null) invalid(`show must have text and be at most ${SHOW_MAX_LENGTH} characters after normalizing`);
  if (UNSAFE_IN_SHOW.test(show) || !show.isWellFormed()) {
    invalid("show contains control or bidirectional override characters, which can change what the user reads");
  }
  if (typeof signer !== "string" || signer.trim() !== signer || signer.length === 0 || signer.length > SIGNER_MAX_LENGTH) {
    invalid("signer must be the person's ID in your app, with no surrounding spaces");
  }
  if (context !== undefined) assertJsonObject(context, "context");
  const key = await sha256Base64Url({
    type: CALL_TYPE,
    name,
    arguments: args,
    show,
    signer,
    ...(context !== undefined ? { context } : {}),
  });
  return {
    name,
    arguments: args,
    show,
    signer,
    ...(context !== undefined ? { context } : {}),
    ...(uiLocales !== undefined ? { uiLocales } : {}),
    key,
  };
}

/** The document for one signature request of a prepared call. */
export function callDocument(prepared: PreparedCall, id: string): CallDocument {
  const document: CallDocument = {
    type: CALL_TYPE,
    id,
    name: prepared.name,
    arguments: prepared.arguments,
    show: prepared.show,
    signer: prepared.signer,
    ...(prepared.context !== undefined ? { context: prepared.context } : {}),
  };
  const bytes = new TextEncoder().encode(canonicalJson(document)).length;
  if (bytes > CALL_MAX_BYTES) {
    throw new SignatureGateError("call_too_large", `the call document is ${bytes} bytes; the limit is ${CALL_MAX_BYTES}`);
  }
  return document;
}

/** `message_digest` of a call document: Base64URL of the SHA-256 of its RFC 8785 form. */
export function messageDigestOf(document: CallDocument): Promise<string> {
  return sha256Base64Url(document);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True when `value` has the exact shape of a version 1 call document. */
export function isCallDocument(value: unknown): value is CallDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const allowed = new Set(["type", "id", "name", "arguments", "show", "signer", "context"]);
  for (const key of Object.keys(o)) if (!allowed.has(key)) return false;
  return (
    o.type === CALL_TYPE &&
    typeof o.id === "string" &&
    UUID.test(o.id) &&
    typeof o.name === "string" &&
    o.name.length > 0 &&
    isJsonObject(o.arguments) &&
    typeof o.show === "string" &&
    normalizeShow(o.show) === o.show &&
    !UNSAFE_IN_SHOW.test(o.show) &&
    typeof o.signer === "string" &&
    o.signer.length > 0 &&
    (o.context === undefined || isJsonObject(o.context))
  );
}
