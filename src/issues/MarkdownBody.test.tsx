import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  checkIssueBody,
  MarkdownBody,
  normalizeIssueMarkdown,
  safeIssueUrl,
} from "./MarkdownBody";

function renderBody(body: string): HTMLElement {
  return render(<MarkdownBody body={body} />).container;
}

describe("MarkdownBody rendering", () => {
  it("renders paragraphs with emphasis, strong, and inline code", () => {
    const container = renderBody("First *em* and **strong** with `code`.");
    expect(container.querySelector("p")?.textContent).toContain("First");
    expect(container.querySelector("em")?.textContent).toBe("em");
    expect(container.querySelector("strong")?.textContent).toBe("strong");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("converts single newlines to line breaks", () => {
    const container = renderBody("line one\nline two");
    expect(container.querySelector("br")).not.toBeNull();
    expect(container.querySelectorAll("br")).toHaveLength(1);
  });

  it("renders ordered and unordered lists", () => {
    const container = renderBody("1. first\n2. second\n\n- a\n- b");
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
  });

  it("renders safe links with external-link attributes", () => {
    renderBody("[docs](https://example.com/docs)");
    const link = screen.getByRole("link", { name: "docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps mailto links", () => {
    renderBody("[mail](mailto:review@example.com)");
    expect(screen.getByRole("link", { name: "mail" }).getAttribute("href")).toBe(
      "mailto:review@example.com",
    );
  });

  it("drops raw HTML blocks instead of rendering them", () => {
    const container = renderBody("before\n\n<script>alert(1)</script>\n\nafter");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("alert");
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
  });

  it("drops inline HTML tags but keeps the surrounding text", () => {
    const container = renderBody("some <b>bold</b> text");
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("bold");
  });

  it("renders no headings, images, tables, or embedded media", () => {
    const container = renderBody(
      "# Title\n\n![alt](https://example.com/x.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<iframe src=\"https://example.com\"></iframe>",
    );
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,foo",
    "/relative/path",
    "./rel",
    "//protocol-relative.example.com",
    "ftp://example.com/file",
  ])("renders the %s link without an href", (href) => {
    const container = renderBody(`[click](${href})`);
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBeNull();
    expect(anchor?.textContent).toBe("click");
  });

  it("blocks entity-encoded javascript: links", () => {
    const container = renderBody("[click](jav&#x61;script:alert(1))");
    expect(container.querySelector("a")?.getAttribute("href")).toBeNull();
  });
});

describe("safeIssueUrl", () => {
  it.each([
    "https://example.com",
    "http://example.com/x?y=1#z",
    "HTTPS://EXAMPLE.COM",
    "mailto:a@b.co",
  ])("allows %s", (url) => {
    expect(safeIssueUrl(url)).toBe(url);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "vbscript:x",
    "file:///etc/passwd",
    "ftp://example.com",
    "/rel",
    "docs/page",
    "//evil.com",
    "not a url",
    "",
  ])("rejects %s", (url) => {
    expect(safeIssueUrl(url)).toBeUndefined();
  });
});

describe("normalizeIssueMarkdown", () => {
  it("converts CRLF and bare CR to LF, mirroring the server", () => {
    expect(normalizeIssueMarkdown("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("performs no other transformation", () => {
    expect(normalizeIssueMarkdown("  spaced  \n\ttabbed ")).toBe("  spaced  \n\ttabbed ");
  });
});

describe("checkIssueBody", () => {
  it("counts Unicode scalar values, not UTF-16 units", () => {
    expect(checkIssueBody("🙂🙂").scalars).toBe(2);
    expect(checkIssueBody("é").scalars).toBe(2);
  });

  it("accepts tab and LF as the only permitted control characters", () => {
    expect(checkIssueBody("a\tb\nc").problem).toBeNull();
  });

  it.each(["", "   ", " \n\t "])("flags the whitespace-only body %j as empty", (body) => {
    expect(checkIssueBody(body).problem).toBe("empty");
  });

  it("preserves leading and trailing whitespace in an otherwise non-empty body", () => {
    expect(checkIssueBody("  padded  ").problem).toBeNull();
  });

  it("accepts exactly 4000 scalars and rejects 4001", () => {
    expect(checkIssueBody("x".repeat(4000)).problem).toBeNull();
    expect(checkIssueBody("x".repeat(4001)).problem).toBe("too_long");
  });

  it("counts astral characters once at the boundary", () => {
    expect(checkIssueBody("🙂".repeat(4000)).problem).toBeNull();
    expect(checkIssueBody("🙂".repeat(4001)).problem).toBe("too_long");
  });

  it.each([0x00, 0x08, 0x0b, 0x1f, 0x7f, 0x85, 0x9f])(
    "flags control character U+%04X",
    (unit) => {
      expect(checkIssueBody(`a${String.fromCharCode(unit)}b`).problem).toBe(
        "control_characters",
      );
    },
  );

  it("flags unpaired surrogates", () => {
    expect(checkIssueBody("a\ud800b").problem).toBe("unpaired_surrogates");
    expect(checkIssueBody("a\udfff").problem).toBe("unpaired_surrogates");
  });

  it("reports the scalar count alongside a problem", () => {
    const check = checkIssueBody("x".repeat(4001));
    expect(check.scalars).toBe(4001);
    expect(check.problem).toBe("too_long");
  });
});

describe("MarkdownBody attachments", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const metadata = {
    id,
    contentType: "image/png" as const,
    width: 400,
    height: 300,
    thumbnailWidth: 400,
    thumbnailHeight: 300,
  };

  it("renders an attachment token as a thumbnail from server-derived URLs", () => {
    const container = render(
      <MarkdownBody body={`See ![gate](attachment:${id})`} attachments={[metadata]} locale="en" />,
    ).container;
    const image = container.querySelector(".issue-image img");
    expect(image?.getAttribute("src")).toBe(`/api/issue-attachments/${id}/thumbnail`);
    expect(image?.getAttribute("alt")).toBe("gate");
    expect(image?.getAttribute("width")).toBe("400");
    expect(image?.getAttribute("height")).toBe("300");
    expect(image?.getAttribute("loading")).toBe("lazy");
    expect(image?.getAttribute("decoding")).toBe("async");
    expect(screen.getByRole("button", { name: "Enlarge image: gate" })).toBeTruthy();
  });

  it("prefers a local blob preview URL (staged editor preview) when present", () => {
    const container = render(
      <MarkdownBody
        body={`![shot](attachment:${id})`}
        attachments={[{ ...metadata, previewUrl: "blob:local-preview" }]}
        locale="en"
      />,
    ).container;
    expect(container.querySelector(".issue-image img")?.getAttribute("src")).toBe("blob:local-preview");
  });

  it("opens an accessible lightbox with the full content and returns focus", async () => {
    const user = userEvent.setup();
    render(
      <>
        <MarkdownBody body={`![gate](attachment:${id})`} attachments={[metadata]} locale="en" />
        <button type="button">Background action</button>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Enlarge image: gate" });
    const background = screen.getByRole("button", { name: "Background action" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "gate" });
    const full = dialog.querySelector(".issue-lightbox__image");
    expect(full?.getAttribute("src")).toBe(`/api/issue-attachments/${id}/content`);
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    expect(background.inert).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(background.inert).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("localizes lightbox controls", async () => {
    const user = userEvent.setup();
    render(
      <MarkdownBody body={`![ゲート](attachment:${id})`} attachments={[metadata]} locale="ja" />,
    );
    await user.click(screen.getByRole("button", { name: "画像を拡大: ゲート" }));
    expect(screen.getByRole("button", { name: "閉じる" })).toBeTruthy();
  });

  it("never renders remote, data:, SVG, or unknown-attachment images", () => {
    const remote = renderBody("![x](https://evil.example/x.png)");
    expect(remote.querySelector("img")).toBeNull();
    expect(remote.textContent).toContain("x");
    const data = renderBody("![x](data:image/png;base64,AAAA)");
    expect(data.querySelector("img")).toBeNull();
    const svg = renderBody(`![x](attachment:${id}.svg)`);
    expect(svg.querySelector("img")).toBeNull();
    const unknown = render(
      <MarkdownBody body={`![alt text](attachment:${id})`} attachments={[]} locale="en" />,
    ).container;
    expect(unknown.querySelector("img")).toBeNull();
    expect(unknown.textContent).toContain("alt text");
  });

  it("strips attachment: hrefs from links", () => {
    const container = render(
      <MarkdownBody body={`[click](attachment:${id})`} attachments={[metadata]} locale="en" />,
    ).container;
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBeNull();
  });

  it("caps rendered image occurrences", () => {
    const body = Array.from({ length: 25 }, () => `![a](attachment:${id})`).join("\n");
    const container = render(
      <MarkdownBody body={body} attachments={[metadata]} locale="en" />,
    ).container;
    expect(container.querySelectorAll(".issue-image")).toHaveLength(20);
  });

  it("escapes alt text and never attaches event handlers from markup", () => {
    const container = render(
      <MarkdownBody
        body={`![<b>bold</b>" onmouseover="x](attachment:${id})`}
        attachments={[metadata]}
        locale="en"
      />,
    ).container;
    const image = container.querySelector(".issue-image img");
    expect(image?.getAttribute("alt")).toBe('<b>bold</b>" onmouseover="x');
    expect(image?.getAttribute("onmouseover")).toBeNull();
  });
});
