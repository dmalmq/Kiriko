import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Dedicated content-addressed store for normalized issue-attachment images.
 * Kept separate from the generic KVB/source blob store (which has no
 * reference GC): the attachment janitor owns this tree and may delete any
 * file whose hash is not referenced by `issue_attachment_blobs`.
 * Backed up as part of `dataDir`.
 */
export class IssueAttachmentStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, "issue-attachments", "sha256");
  }

  static hashBytes(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  path(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash);
  }

  has(hash: string): boolean {
    return existsSync(this.path(hash));
  }

  readAsync(hash: string): Promise<Buffer> {
    return readFile(this.path(hash));
  }

  /** Content-addressed write; an existing identical file is reused. */
  put(bytes: Uint8Array): { hash: string; size: number } {
    const hash = IssueAttachmentStore.hashBytes(bytes);
    const target = this.path(hash);
    if (!existsSync(target)) {
      const dir = join(this.root, hash.slice(0, 2));
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
      try {
        writeFileSync(tmp, bytes);
        renameSync(tmp, target);
      } catch (error) {
        try {
          unlinkSync(tmp);
        } catch {}
        throw error;
      }
    }
    return { hash, size: bytes.byteLength };
  }

  remove(hash: string): void {
    try {
      unlinkSync(this.path(hash));
    } catch {
      // Already gone; removal is idempotent.
    }
  }

  /** Every hash-like file in the tree (skips in-flight temp files). */
  list(): string[] {
    const hashes: string[] = [];
    if (!existsSync(this.root)) {
      return hashes;
    }
    for (const prefix of readdirSync(this.root)) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) {
        continue;
      }
      const dir = join(this.root, prefix);
      for (const file of readdirSync(dir)) {
        if (/^[0-9a-f]{64}$/.test(file)) {
          hashes.push(file);
        }
      }
    }
    return hashes;
  }

  mtimeMs(hash: string): number | null {
    try {
      return statSync(this.path(hash)).mtimeMs;
    } catch {
      return null;
    }
  }
}
