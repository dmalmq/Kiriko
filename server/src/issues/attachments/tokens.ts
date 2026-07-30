import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * Attachment token contract, shared semantics with the web client
 * (`src/issues/attachmentTokens.ts`). A Markdown image whose destination is
 * `attachment:<id>` references a first-party attachment; only lowercase
 * canonical IDs are valid. Anything else (remote URLs, data URIs, relative
 * paths, SVG) is never a renderable attachment.
 */
export const ATTACHMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ATTACHMENT_SCHEME = "attachment:";
export const ATTACHMENT_ALT_MAX_SCALARS = 300;

export interface AttachmentToken {
  id: string;
  alt: string;
}

interface MdastNode {
  type: string;
  url?: string;
  alt?: string;
  children?: MdastNode[];
}

function walk(node: MdastNode, visit: (node: MdastNode) => void): void {
  visit(node);
  if (node.children !== undefined) {
    for (const child of node.children) {
      walk(child, visit);
    }
  }
}

/**
 * Parses the attachment tokens of a normalized Markdown body with the same
 * CommonMark parser the client renderer uses, so code spans/blocks and other
 * non-image positions never count. Returns tokens in document order with
 * duplicate IDs collapsed to their first occurrence.
 */
export function parseAttachmentTokens(body: string): AttachmentToken[] {
  const tree = fromMarkdown(body) as unknown as MdastNode;
  const tokens: AttachmentToken[] = [];
  const seen = new Set<string>();
  walk(tree, (node) => {
    if (node.type !== "image" || typeof node.url !== "string") {
      return;
    }
    if (!node.url.startsWith(ATTACHMENT_SCHEME)) {
      return;
    }
    const id = node.url.slice(ATTACHMENT_SCHEME.length);
    if (!ATTACHMENT_ID_PATTERN.test(id) || seen.has(id)) {
      return;
    }
    seen.add(id);
    tokens.push({ id, alt: typeof node.alt === "string" ? node.alt : "" });
  });
  return tokens;
}

/** Unique canonical attachment IDs referenced by a body, in document order. */
export function parseAttachmentTokenIds(body: string): string[] {
  return parseAttachmentTokens(body).map((token) => token.id);
}
