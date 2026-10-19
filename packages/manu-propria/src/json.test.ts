import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Base64Url } from "./json.js";

describe("canonicalJson (RFC 8785)", () => {
  it("orders members by UTF-16 code units, as in the RFC's example", () => {
    const value = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalJson(value)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",' +
        '"€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("writes numbers the way ECMAScript does", () => {
    expect(canonicalJson([1e30, 4.5, 2e-3, 0.000001, 1e-7, -0, 333333333.33333329, 1e21])).toBe(
      "[1e+30,4.5,0.002,0.000001,1e-7,0,333333333.3333333,1e+21]",
    );
  });

  it("escapes only what JSON requires", () => {
    expect(canonicalJson({ s: '\u0000\u001f"\\/\u007f ' })).toBe('{"s":"\\u0000\\u001f\\"\\\\/\u007f "}');
  });

  it("refuses values that have no single JSON form", () => {
    const sparse = [1, , 3];
    const cases: [unknown, RegExp][] = [
      [{ a: undefined }, /a is undefined/],
      [{ n: Number.NaN }, /n is not a finite number/],
      [{ n: Number.POSITIVE_INFINITY }, /not a finite number/],
      [{ d: new Date(0) }, /d is not a plain object/],
      [{ m: new Map() }, /not a plain object/],
      [{ b: 1n }, /bigint/],
      [{ f: () => 1 }, /function/],
      [{ s: "\ud800" }, /lone surrogate/],
      [{ arr: sparse }, /arr\[1\] is a hole/],
      [{ [Symbol("x")]: 1 }, /symbol keys/],
    ];
    for (const [value, message] of cases) expect(() => canonicalJson(value), String(message)).toThrow(message);
  });

  it("refuses nesting it cannot bound", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 70; i += 1) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/nested deeper/);
  });

  it("hashes the canonical form, so member order does not change the digest", async () => {
    const a = await sha256Base64Url({ b: 2, a: [1, { y: true, x: null }] });
    const b = await sha256Base64Url({ a: [1, { x: null, y: true }], b: 2 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
