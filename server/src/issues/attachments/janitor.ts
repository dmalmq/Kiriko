import type Database from "better-sqlite3";
import {
  ATTACHMENT_DETACHED_RETENTION_MS,
  ATTACHMENT_ORPHAN_FILE_AGE_MS,
  ATTACHMENT_STAGED_RETENTION_MS,
  ATTACHMENT_TOMBSTONE_RETENTION_MS,
} from "./limits";
import { IssueAttachmentRepository } from "./repository";
import type { IssueAttachmentStore } from "./store";

/**
 * Deterministic orphan cleanup. Staged uploads expire after 24 h, detached
 * and tombstoned media after 30 days; blob rows/files are freed only once no
 * attachment row references their hash, and filesystem files with no
 * metadata row are removed after a safety age (covers SQLite/filesystem
 * crash gaps). Never bumps the issue revision: no live body changes.
 */
export function runIssueAttachmentJanitor(
  db: Database.Database,
  store: IssueAttachmentStore,
  now: Date = new Date(),
): { removedAttachments: number; removedBlobs: number; removedFiles: number } {
  const repository = new IssueAttachmentRepository(db);
  const nowMs = now.getTime();
  const stagedCutoff = new Date(nowMs - ATTACHMENT_STAGED_RETENTION_MS).toISOString();
  const detachedCutoff = new Date(nowMs - ATTACHMENT_DETACHED_RETENTION_MS).toISOString();
  const tombstoneCutoff = new Date(nowMs - ATTACHMENT_TOMBSTONE_RETENTION_MS).toISOString();

  const expired = [
    ...repository.expiredStagedIds(stagedCutoff),
    ...repository.expiredDetachedIds(detachedCutoff),
    ...repository.tombstonedAttachedIds(tombstoneCutoff),
  ];
  repository.deleteAttachments(expired);

  const unreferenced = repository.unreferencedBlobHashes();
  repository.deleteBlobRows(unreferenced);
  for (const hash of unreferenced) {
    store.remove(hash);
  }

  const known = repository.allBlobHashes();
  let removedFiles = 0;
  for (const hash of store.list()) {
    if (known.has(hash)) {
      continue;
    }
    const mtime = store.mtimeMs(hash);
    if (mtime !== null && mtime < nowMs - ATTACHMENT_ORPHAN_FILE_AGE_MS) {
      store.remove(hash);
      removedFiles += 1;
    }
  }

  return {
    removedAttachments: expired.length,
    removedBlobs: unreferenced.length,
    removedFiles,
  };
}
