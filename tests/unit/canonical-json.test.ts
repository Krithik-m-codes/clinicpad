import { describe, expect, it } from "vitest";
import { canonicalJson } from "@/lib/rx-render/canonical-json";

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: "x" } })).toBe('{"a":{"c":"x","d":[3,1,2]},"b":1}');
    expect(canonicalJson({ a: { c: "x", d: [3, 1, 2] }, b: 1 })).toBe(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: "x" } }));
  });

  it("omits undefined properties and escapes strings like JSON", () => {
    expect(canonicalJson({ a: undefined, b: 'q"\n\u2028' })).toBe('{"b":"q\\"\\n\u2028"}');
    expect(canonicalJson([null, true, false, 0, -0, 1.5])).toBe("[null,true,false,0,0,1.5]");
  });

  it("refuses values JSON cannot represent exactly", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
    expect(() => canonicalJson(BigInt(1))).toThrow();
  });

  it("keeps a __proto__ own key as data and never touches the prototype", () => {
    const parsed: unknown = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"polluted":true},"a":1}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
