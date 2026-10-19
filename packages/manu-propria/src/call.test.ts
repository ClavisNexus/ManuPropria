import { describe, expect, it } from "vitest";
import { CALL_TYPE, callDocument, isCallDocument, messageDigestOf, prepareCall, type Call } from "./call.js";
import { SignatureGateError } from "./errors.js";
import { canonicalJson } from "./json.js";
import { normalizeShow } from "./show.js";

const call: Call = {
  name: "refund",
  arguments: { orderId: "1042", amount: 120 },
  show: "Refund $120.00 on order 1042",
  signer: "pw-alice",
};

describe("normalizeShow", () => {
  it("normalizes the way Connect binds the line", () => {
    expect(normalizeShow("  Refund\t$120\n on  order 1042 ")).toBe("Refund $120 on order 1042");
    expect(normalizeShow("Café order")).toBe("Café order");
    expect(normalizeShow("a".repeat(500))).toHaveLength(500);
  });

  it("refuses an empty line and one longer than Connect shows", () => {
    expect(normalizeShow(" \n ")).toBeNull();
    expect(normalizeShow("a".repeat(501))).toBeNull();
    expect(normalizeShow(42)).toBeNull();
  });
});

describe("prepareCall", () => {
  it("gives the same key to the same call, whatever the member order", async () => {
    const a = await prepareCall(call);
    const b = await prepareCall({ ...call, arguments: { amount: 120, orderId: "1042" }, show: " Refund  $120.00 on order 1042" });
    expect(a.key).toBe(b.key);
  });

  it("gives another key when anything the person signs changes", async () => {
    const base = (await prepareCall(call)).key;
    const variants: Call[] = [
      { ...call, name: "refund_all" },
      { ...call, arguments: { orderId: "1042", amount: 121 } },
      { ...call, show: "Refund $121.00 on order 1042" },
      { ...call, signer: "pw-bob" },
      { ...call, context: { mcp: { client_id: "https://client.example/metadata.json" } } },
    ];
    for (const variant of variants) expect((await prepareCall(variant)).key).not.toBe(base);
  });

  it("does not let the screen languages change what is signed", async () => {
    expect((await prepareCall({ ...call, uiLocales: ["ja"] })).key).toBe((await prepareCall(call)).key);
  });

  it("refuses calls that cannot be signed as given", async () => {
    const bad: unknown[] = [
      { ...call, name: "" },
      { ...call, name: "x".repeat(201) },
      { ...call, name: "line\nbreak" },
      { ...call, arguments: [] },
      { ...call, arguments: { when: new Date(0) } },
      { ...call, show: "   " },
      { ...call, show: "a".repeat(501) },
      { ...call, show: "Refund $120.00 on order ‮2401‬" },
      { ...call, show: "Make ana ⁦admin⁩ of design" },
      { ...call, show: "Refund\u0007 $120.00" },
      { ...call, show: "Refund \ud800" },
      { ...call, signer: "" },
      { ...call, signer: " pw-alice" },
      { ...call, context: "mcp" },
    ];
    for (const value of bad) {
      await expect(prepareCall(value as Call)).rejects.toMatchObject({ name: "SignatureGateError", code: "invalid_call" });
    }
  });
});

describe("callDocument", () => {
  it("puts the normalized line and a request id into the signed document", async () => {
    const prepared = await prepareCall({ ...call, show: "Refund  $120.00 on order 1042\n" });
    const id = crypto.randomUUID();
    const document = callDocument(prepared, id);
    expect(document).toEqual({
      type: CALL_TYPE,
      id,
      name: "refund",
      arguments: { orderId: "1042", amount: 120 },
      show: "Refund $120.00 on order 1042",
      signer: "pw-alice",
    });
    expect(isCallDocument(document)).toBe(true);
  });

  it("digests the RFC 8785 form of the document", async () => {
    const document = callDocument(await prepareCall(call), "6f1c1b0e-3f1a-4c55-9c1b-2a1d6c0f7e10");
    expect(canonicalJson(document)).toBe(
      '{"arguments":{"amount":120,"orderId":"1042"},"id":"6f1c1b0e-3f1a-4c55-9c1b-2a1d6c0f7e10","name":"refund","show":"Refund $120.00 on order 1042","signer":"pw-alice","type":"manu_propria.call@1"}',
    );
    const expected = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(document)));
    const b64 = Buffer.from(expected).toString("base64url");
    expect(await messageDigestOf(document)).toBe(b64);
  });

  it("refuses a document larger than a request may carry", async () => {
    const prepared = await prepareCall({ ...call, arguments: { blob: "x".repeat(300 * 1024) } });
    expect(() => callDocument(prepared, crypto.randomUUID())).toThrow(SignatureGateError);
  });

  it("recognises only the exact version 1 shape", async () => {
    const document = callDocument(await prepareCall(call), crypto.randomUUID());
    expect(isCallDocument({ ...document, extra: true })).toBe(false);
    expect(isCallDocument({ ...document, type: "manu_propria.call@2" })).toBe(false);
    expect(isCallDocument({ ...document, id: "not-a-uuid" })).toBe(false);
    expect(isCallDocument({ ...document, show: " padded " })).toBe(false);
  });
});
