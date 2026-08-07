import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

export class BlobStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, "blobs", "sha256");
  }

  path(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash);
  }

  has(hash: string): boolean {
    return existsSync(this.path(hash));
  }

  /** Byte length on disk, or `null` when the blob is absent. */
  size(hash: string): number | null {
    try {
      return statSync(this.path(hash)).size;
    } catch {
      return null;
    }
  }

  /**
   * Stream a blob, or an inclusive byte range of one.
   *
   * Tile members run to hundreds of megabytes, so serving one — or resuming
   * 1 MiB of one — must not read the whole thing into memory, and must not copy
   * it anywhere else to become streamable. The bytes are read in place from the
   * single content-addressed copy.
   */
  stream(hash: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.path(hash), range);
  }

  read(hash: string): Buffer {
    return readFileSync(this.path(hash));
  }

  readAsync(hash: string): Promise<Buffer> {
    return readFile(this.path(hash));
  }

  /**
   * Delete a blob's bytes, returning how many were released (`0` when the blob
   * was already gone). Only garbage collection calls this: the store is
   * otherwise append-only, because a blob is immutable and shared.
   *
   * A failure to unlink is reported as zero bytes released rather than thrown —
   * the caller has already removed the reference, and an unreferenced file left
   * on disk is waste, not corruption.
   */
  remove(hash: string): number {
    const target = this.path(hash);
    try {
      const size = statSync(target).size;
      rmSync(target);
      return size;
    } catch {
      return 0;
    }
  }

  put(bytes: Uint8Array): { hash: string; size: number } {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const target = this.path(hash);
    if (!existsSync(target)) {
      const dir = join(this.root, hash.slice(0, 2));
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, target);
    }
    return { hash, size: bytes.byteLength };
  }
}
