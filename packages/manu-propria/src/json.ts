/**
 * JSON values and their canonical form (RFC 8785, JSON Canonicalization Scheme).
 *
 * The digest a person signs is the SHA-256 of this form, so anything that could serialize in
 * more than one way is refused here instead of being coerced.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

const MAX_DEPTH = 64;

function describe(path: string): string {
  return path === "" ? "the value" : path;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, path: string, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError(`${describe(path)} is nested deeper than ${MAX_DEPTH} levels`);
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${describe(path)} is not a finite number`);
      // ECMAScript Number::toString, which RFC 8785 adopts (-0 serializes as 0)
      return JSON.stringify(value);
    case "string":
      if (!value.isWellFormed()) throw new TypeError(`${describe(path)} contains a lone surrogate`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`${describe(path)} is a ${typeof value}, which JSON cannot carry`);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) throw new TypeError(`${path}[${i}] is a hole in the array`);
      items.push(serialize(value[i], `${path}[${i}]`, depth + 1));
    }
    return `[${items.join(",")}]`;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`${describe(path)} is not a plain object (${Object.prototype.toString.call(value)})`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${describe(path)} has symbol keys`);
  }
  const record = value as Record<string, unknown>;
  // Default string order compares UTF-16 code units, which is the order RFC 8785 requires
  const keys = Object.keys(record).sort();
  const members: string[] = [];
  for (const key of keys) {
    if (!key.isWellFormed()) throw new TypeError(`a key in ${describe(path)} contains a lone surrogate`);
    const child = path === "" ? key : `${path}.${key}`;
    if (record[key] === undefined) throw new TypeError(`${child} is undefined`);
    members.push(`${JSON.stringify(key)}:${serialize(record[key], child, depth + 1)}`);
  }
  return `{${members.join(",")}}`;
}

/** The RFC 8785 serialization of `value`. Throws a TypeError naming the first part JSON cannot carry exactly. */
export function canonicalJson(value: unknown): string {
  return serialize(value, "", 0);
}

/** True for a plain object whose every member is a JSON value. */
export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 of the canonical form, as unpadded Base64URL (43 characters). */
export async function sha256Base64Url(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
