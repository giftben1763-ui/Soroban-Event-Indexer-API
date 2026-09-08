import { describe, expect, it } from "vitest";
import { decodeEvent, MalformedEventError } from "../src/decode/eventDecoder.js";
import { makeRawEvent } from "./helpers/fixtures.js";

describe("decodeEvent", () => {
  it("decodes a well-formed event into native values", () => {
    const raw = makeRawEvent({ ledger: 42, topics: ["transfer"], value: { amount: 500n, to: "bob" } });
    const decoded = decodeEvent(raw);
    expect(decoded.eventType).toBe("transfer");
    expect(decoded.topics).toEqual(["transfer"]);
    expect(decoded.value).toEqual({ amount: 500n, to: "bob" });
    expect(decoded.ledger).toBe(42);
    expect(decoded.pagingToken).toBe(raw.pagingToken);
  });

  it.each([
    ["not an object", "banana"],
    ["null", null],
    ["missing ledger", { ...makeRawEvent({ ledger: 1 }), ledger: undefined }],
    ["non-numeric ledger", { ...makeRawEvent({ ledger: 1 }), ledger: "one" }],
    ["missing contractId", { ...makeRawEvent({ ledger: 1 }), contractId: undefined }],
    ["missing pagingToken", { ...makeRawEvent({ ledger: 1 }), pagingToken: "" }],
    ["topic not an array", { ...makeRawEvent({ ledger: 1 }), topic: "transfer" }],
    ["topic entry not a string", { ...makeRawEvent({ ledger: 1 }), topic: [123] }],
    ["topic entry not valid XDR", { ...makeRawEvent({ ledger: 1 }), topic: ["!!!not-base64-xdr"] }],
    ["value not a string", { ...makeRawEvent({ ledger: 1 }), value: 42 }],
    ["value not valid XDR", { ...makeRawEvent({ ledger: 1 }), value: "!!!not-base64-xdr" }],
  ])("throws MalformedEventError for: %s", (_label, raw) => {
    expect(() => decodeEvent(raw)).toThrow(MalformedEventError);
  });

  it("falls back to null eventType when there are no topics", () => {
    const raw = { ...makeRawEvent({ ledger: 1 }), topic: [] };
    const decoded = decodeEvent(raw);
    expect(decoded.eventType).toBeNull();
  });

  it("supports contracts that prefix topics with a namespace (e.g. Soroswap's pair contract)", () => {
    // Soroswap's pair contract publishes topics = ("SoroswapPair", "swap", ...).
    const raw = makeRawEvent({ ledger: 1, topics: ["SoroswapPair", "swap"] });
    expect(decodeEvent(raw).eventType).toBe("SoroswapPair");
    expect(decodeEvent(raw, { eventTypeTopicIndex: 1 }).eventType).toBe("swap");
  });
});
