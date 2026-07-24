import { describe, expect, it } from "vitest";
import { parseViewerParams } from "./viewerParams";

const BASE = "https://viewer.test/";

describe("parseViewerParams", () => {
  it("accepts absolute http(s) src verbatim", () => {
    expect(parseViewerParams("?src=https://cdn.example.com/venue.zip", BASE).src).toBe(
      "https://cdn.example.com/venue.zip",
    );
    expect(parseViewerParams("?src=http://cdn.example.com/venue.zip", BASE).src).toBe(
      "http://cdn.example.com/venue.zip",
    );
  });

  it("accepts relative src paths resolved against the base", () => {
    expect(parseViewerParams("?src=/venues/tokyo.zip", BASE).src).toBe("/venues/tokyo.zip");
    expect(parseViewerParams("?src=venues/tokyo.zip", BASE).src).toBe("venues/tokyo.zip");
  });

  it("rejects non-http(s) schemes and malformed URLs", () => {
    expect(parseViewerParams("?src=javascript:alert(1)", BASE).src).toBeNull();
    expect(parseViewerParams("?src=data:application/zip;base64,AAAA", BASE).src).toBeNull();
    expect(parseViewerParams("?src=http://", BASE).src).toBeNull();
    expect(parseViewerParams("", BASE).src).toBeNull();
  });

  it("trims level and treats empty as absent", () => {
    expect(parseViewerParams("?level=%20b1f%20", BASE).level).toBe("b1f");
    expect(parseViewerParams("?level=", BASE).level).toBeNull();
    expect(parseViewerParams("?level=%20%20", BASE).level).toBeNull();
    expect(parseViewerParams("", BASE).level).toBeNull();
  });

  it("parses embed truthy forms and rejects others", () => {
    expect(parseViewerParams("?embed", BASE).embed).toBe(true);
    expect(parseViewerParams("?embed=1", BASE).embed).toBe(true);
    expect(parseViewerParams("?embed=true", BASE).embed).toBe(true);
    expect(parseViewerParams("?embed=TRUE", BASE).embed).toBe(true);
    expect(parseViewerParams("?embed=0", BASE).embed).toBe(false);
    expect(parseViewerParams("?embed=yes", BASE).embed).toBe(false);
    expect(parseViewerParams("", BASE).embed).toBe(false);
  });

  it("whitelists lang", () => {
    expect(parseViewerParams("?lang=ja", BASE).locale).toBe("ja");
    expect(parseViewerParams("?lang=en", BASE).locale).toBe("en");
    expect(parseViewerParams("?lang=fr", BASE).locale).toBeNull();
    expect(parseViewerParams("", BASE).locale).toBeNull();
  });

  it("ignores the legacy theme param", () => {
    expect("themeId" in parseViewerParams("?theme=customer-blue", BASE)).toBe(false);
    expect(parseViewerParams("?theme=neon&lang=en", BASE).locale).toBe("en");
  });

  it("parses dataset slug, trimming and treating empty as absent", () => {
    expect(parseViewerParams("?dataset=shinjuku-station", BASE).dataset).toBe("shinjuku-station");
    expect(parseViewerParams("?dataset=%20abc%20", BASE).dataset).toBe("abc");
    expect(parseViewerParams("?dataset=", BASE).dataset).toBeNull();
    expect(parseViewerParams("", BASE).dataset).toBeNull();
  });

  it("parses the bare viewer flag", () => {
    expect(parseViewerParams("?viewer", BASE).forceViewer).toBe(true);
    expect(parseViewerParams("?viewer=1", BASE).forceViewer).toBe(true);
    expect(parseViewerParams("", BASE).forceViewer).toBe(false);
  });

  it("parses the review flag", () => {
    expect(parseViewerParams("?review", BASE).review).toBe(true);
    expect(parseViewerParams("?review=1", BASE).review).toBe(true);
    expect(parseViewerParams("", BASE).review).toBe(false);
  });

  it("parses an optional 64-hex version identity, degrading invalid values to absent", () => {
    const id = "a".repeat(64);
    expect(parseViewerParams(`?version=${id}`, BASE).version).toBe(id);
    expect(parseViewerParams(`?version=%20${id}%20`, BASE).version).toBe(id);
    expect(parseViewerParams(`?version=${"A".repeat(64)}`, BASE).version).toBeNull(); // uppercase
    expect(parseViewerParams(`?version=${"a".repeat(63)}`, BASE).version).toBeNull(); // too short
    expect(parseViewerParams(`?version=${"a".repeat(65)}`, BASE).version).toBeNull(); // too long
    expect(parseViewerParams("?version=3", BASE).version).toBeNull(); // legacy numeric seq
    expect(parseViewerParams("?version=", BASE).version).toBeNull();
    expect(parseViewerParams("", BASE).version).toBeNull();
  });
});
