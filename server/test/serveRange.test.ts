/**
 * Range header parsing (#73).
 *
 * Sending the wrong bytes under a 206 is worse than refusing the range, because
 * the client believes them and writes them into a file it thinks is complete.
 * So the interesting cases here are the ones where a plausible implementation
 * answers confidently and wrongly.
 */
import { describe, expect, it } from "vitest";
import { parseRange } from "../src/serve/range";

const SIZE = 1000;

describe("parseRange", () => {
  it("treats a missing or empty header as a whole-member request", () => {
    expect(parseRange(undefined, SIZE)).toEqual({ kind: "whole" });
    expect(parseRange("", SIZE)).toEqual({ kind: "whole" });
    expect(parseRange("   ", SIZE)).toEqual({ kind: "whole" });
  });

  it("reads an explicit inclusive range", () => {
    expect(parseRange("bytes=0-499", SIZE)).toEqual({ kind: "range", start: 0, end: 499 });
    expect(parseRange("bytes=500-999", SIZE)).toEqual({ kind: "range", start: 500, end: 999 });
    // A single byte is a range, not a degenerate case.
    expect(parseRange("bytes=7-7", SIZE)).toEqual({ kind: "range", start: 7, end: 7 });
  });

  it("clamps an end past the last byte instead of overreading", () => {
    expect(parseRange("bytes=900-5000", SIZE)).toEqual({ kind: "range", start: 900, end: 999 });
  });

  it("reads an open-ended range as everything that remains", () => {
    expect(parseRange("bytes=900-", SIZE)).toEqual({ kind: "range", start: 900, end: 999 });
    expect(parseRange("bytes=0-", SIZE)).toEqual({ kind: "range", start: 0, end: 999 });
  });

  it("reads a suffix range as the last bytes, clamped to the member", () => {
    expect(parseRange("bytes=-100", SIZE)).toEqual({ kind: "range", start: 900, end: 999 });
    // Asking for more than exists is the whole member, not an error.
    expect(parseRange("bytes=-5000", SIZE)).toEqual({ kind: "range", start: 0, end: 999 });
  });

  it("refuses a range that starts past the end", () => {
    expect(parseRange("bytes=1000-1500", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=1000-", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("refuses a zero-length suffix, and any suffix of an empty member", () => {
    // `bytes=-0` asks for the last zero bytes: satisfiable by nothing.
    expect(parseRange("bytes=-0", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-1", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("ignores a malformed header rather than guessing at it", () => {
    // RFC 9110: an unrecognised or invalid Range is ignored, and the whole
    // representation is sent. Guessing risks a confident 206 of wrong bytes.
    for (const header of [
      "items=0-10",
      "bytes=abc-def",
      "bytes=",
      "bytes=-",
      "bytes=10-5", // last-byte-pos below first-byte-pos invalidates the header
      "bytes 0-10",
    ]) {
      expect(parseRange(header, SIZE), header).toEqual({ kind: "whole" });
    }
  });

  it("answers a multi-range request whole rather than half-implementing multipart", () => {
    expect(parseRange("bytes=0-9,20-29", SIZE)).toEqual({ kind: "whole" });
  });

  it("is case-insensitive about the unit, as the header grammar is", () => {
    expect(parseRange("Bytes=0-9", SIZE)).toEqual({ kind: "range", start: 0, end: 9 });
  });

  it("ignores positions too large to be exact integers", () => {
    // Beyond 2^53 a decimal position cannot round-trip, so honouring it would
    // mean serving bytes the client did not ask for.
    expect(parseRange("bytes=0-99999999999999999999", SIZE)).toEqual({ kind: "whole" });
  });
});
