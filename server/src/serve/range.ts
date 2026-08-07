/**
 * Single-range `Range` header parsing for byte content (RFC 9110 §14).
 *
 * A tile member can be hundreds of megabytes, so a client that loses its
 * connection must be able to resume rather than start again. That makes range
 * handling a correctness surface: sending the wrong bytes with a 206 is worse
 * than refusing the range, because the client will believe them.
 */

export type RangeRequest =
  /** No range, or one this server declines to honour: send the whole member. */
  | { kind: "whole" }
  /** Inclusive byte positions, already clamped to the member's size. */
  | { kind: "range"; start: number; end: number }
  /** Syntactically valid but outside the member: 416 with the real size. */
  | { kind: "unsatisfiable" };

/**
 * Interpret a `Range` header against a known size.
 *
 * Multi-range requests are answered whole rather than as `multipart/byteranges`:
 * RFC 9110 permits ignoring a range, no 3D Tiles client asks for several at
 * once, and a partial multipart implementation would be a worse answer than an
 * honest complete one. A malformed header is ignored for the same reason — the
 * spec requires it, and guessing at intent risks sending wrong bytes.
 */
export function parseRange(header: string | undefined, size: number): RangeRequest {
  if (header === undefined || header.trim() === "") {
    return { kind: "whole" };
  }
  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (match === null) {
    return { kind: "whole" };
  }
  const specs = match[1]!.split(",");
  if (specs.length !== 1) {
    return { kind: "whole" };
  }
  const spec = specs[0]!.trim();
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (parts === null) {
    return { kind: "whole" };
  }
  const firstText = parts[1]!;
  const lastText = parts[2]!;
  if (firstText === "" && lastText === "") {
    return { kind: "whole" };
  }

  // A suffix range: the last N bytes. `bytes=-0` asks for nothing, which is
  // unsatisfiable rather than empty.
  if (firstText === "") {
    const suffix = Number(lastText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return { kind: "unsatisfiable" };
    }
    if (size === 0) {
      return { kind: "unsatisfiable" };
    }
    return { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(firstText);
  if (!Number.isSafeInteger(start)) {
    return { kind: "whole" };
  }
  if (start >= size) {
    return { kind: "unsatisfiable" };
  }
  if (lastText === "") {
    return { kind: "range", start, end: size - 1 };
  }
  const end = Number(lastText);
  if (!Number.isSafeInteger(end)) {
    return { kind: "whole" };
  }
  // last-byte-pos below first-byte-pos makes the whole header invalid, and an
  // invalid header must be ignored, not refused.
  if (end < start) {
    return { kind: "whole" };
  }
  return { kind: "range", start, end: Math.min(end, size - 1) };
}
