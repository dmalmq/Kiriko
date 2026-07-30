import type { SessionUser } from "../auth/sessions";
import type { BundleAnchorIndex } from "../core/native";
import { AnchorIndexCache } from "./anchorIndex";
import { IssueServiceError } from "./errors";
import type {
  IssueMutationContext,
  IssueRepository,
  PublishedReviewVersion,
  ReplyMutationContext,
  RepositoryMutationResult,
} from "./repository";
import type {
  IssueCollection,
  IssueMutationResult,
  IssuePatch,
  NormalizedIssuePatch,
  NormalizedReplyPatch,
  ReplyCreateBody,
  ReplyPatch,
  ReviewerSummary,
  RootCreateBody,
} from "./types";
import {
  hashReplyCreate,
  hashRootCreate,
  normalizeReplyCreate,
  normalizeRootCreate,
  resolveAttachmentIds,
  validateCoordinates,
  validateDueDate,
  validateMarkdownBody,
  validateRequestId,
} from "./validation";

export type CreateIssueInput = RootCreateBody;
export type CreateReplyInput = ReplyCreateBody;
export type ReplyBodyPatch = ReplyPatch;

export type IssueRepositoryPort = Pick<
  IssueRepository,
  | "resolvePublishedVersion"
  | "getCollection"
  | "listReviewers"
  | "getIssueContext"
  | "getReplyContext"
  | "probeCreateReplay"
  | "createRoot"
  | "createReply"
  | "patchIssue"
  | "patchReply"
  | "deleteIssue"
  | "deleteReply"
>;

export interface IssueRevisionPublisher {
  publishRevision(publicVersionId: string, revision: number): void;
}

type AnchorIndexProvider = Pick<AnchorIndexCache, "get">;
type Clock = () => string;

const NOT_FOUND_MESSAGE = "The review issue was not found.";
const DELETED_MESSAGE = "This review issue has been deleted.";
const FORBIDDEN_MESSAGE = "You cannot change this review issue.";
const STALE_MESSAGE = "The issue changed since you loaded it.";
const INTERNAL_MESSAGE = "Could not update review issues.";

function notFound(): never {
  throw new IssueServiceError("not_found", NOT_FOUND_MESSAGE);
}

function deleted(): never {
  throw new IssueServiceError("issue_deleted", DELETED_MESSAGE);
}

function forbidden(): never {
  throw new IssueServiceError("forbidden", FORBIDDEN_MESSAGE);
}

function assertExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new IssueServiceError("invalid_request", "invalid_request", {
      details: [{ field: "expectedVersion", reason: "must be a positive integer" }],
    });
  }
}

function assertAssigneeId(value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
    throw new IssueServiceError("invalid_request", "invalid_request", {
      details: [{ field: "assigneeId", reason: "must be a positive integer user id" }],
    });
  }
}

function assertLive(context: IssueMutationContext | ReplyMutationContext): void {
  if (context.deletedAt !== null) {
    deleted();
  }
}

export class IssueService {
  constructor(
    private readonly repository: IssueRepositoryPort,
    private readonly anchors: AnchorIndexProvider,
    private readonly publisher: IssueRevisionPublisher,
    private readonly clock: Clock = () => new Date().toISOString(),
  ) {}

  getCollection(publicVersionId: string): IssueCollection {
    const version = this.repository.resolvePublishedVersion(publicVersionId);
    if (version === null) {
      notFound();
    }
    return this.repository.getCollection(version.versionId);
  }

  listReviewers(user: SessionUser): ReviewerSummary[] {
    void user;
    return this.repository.listReviewers();
  }

  async createIssue(
    user: SessionUser,
    publicVersionId: string,
    input: CreateIssueInput,
  ): Promise<IssueMutationResult> {
    const requestId = validateRequestId(input.requestId);
    const normalized = normalizeRootCreate(input);
    normalized.bodyMarkdown = validateMarkdownBody(normalized.bodyMarkdown);
    normalized.attachmentIds = resolveAttachmentIds(normalized.bodyMarkdown, input.attachmentIds);
    validateCoordinates(normalized.longitude, normalized.latitude);
    assertAssigneeId(normalized.assigneeId);
    if (normalized.dueDate !== null) {
      normalized.dueDate = validateDueDate(normalized.dueDate);
    }

    const version = this.repository.resolvePublishedVersion(publicVersionId);
    if (version === null) {
      notFound();
    }
    const requestHash = hashRootCreate(normalized, version.versionId);
    const replay = this.repository.probeCreateReplay(user.id, requestId, requestHash);
    if (replay !== null) {
      return this.finishMutation(replay);
    }

    this.authorizeCreateMetadata(user, normalized.assigneeId, normalized.dueDate);
    this.assertReviewerExists(normalized.assigneeId);

    let index: BundleAnchorIndex;
    try {
      index = await this.anchors.get(version.bundleHash);
    } catch {
      throw new IssueServiceError("internal_error", INTERNAL_MESSAGE);
    }
    this.validateAnchor(index, normalized.levelId, normalized.featureId);

    return this.finishMutation(
      this.repository.createRoot({
        version,
        authorId: user.id,
        requestId,
        requestHash,
        input: normalized,
        now: this.clock(),
      }),
    );
  }

  async createReply(
    user: SessionUser,
    issueId: string,
    input: CreateReplyInput,
  ): Promise<IssueMutationResult> {
    const requestId = validateRequestId(input.requestId);
    const normalized = normalizeReplyCreate(input);
    normalized.bodyMarkdown = validateMarkdownBody(normalized.bodyMarkdown);
    normalized.attachmentIds = resolveAttachmentIds(normalized.bodyMarkdown, input.attachmentIds);

    const context = this.repository.getIssueContext(issueId);
    if (context === null) {
      notFound();
    }
    const requestHash = hashReplyCreate(normalized, context.versionId, context.issueId);
    const replay = this.repository.probeCreateReplay(user.id, requestId, requestHash);
    if (replay !== null) {
      return this.finishMutation(replay);
    }
    assertLive(context);

    const version: PublishedReviewVersion = {
      versionId: context.versionId,
      publicVersionId: context.publicVersionId,
      bundleHash: this.resolveContextBundle(context),
    };
    return this.finishMutation(
      this.repository.createReply({
        version,
        parentIssueId: context.issueId,
        authorId: user.id,
        requestId,
        requestHash,
        input: normalized,
        now: this.clock(),
      }),
    );
  }

  async patchIssue(
    user: SessionUser,
    issueId: string,
    patch: IssuePatch,
  ): Promise<IssueMutationResult> {
    const normalized = this.normalizeIssuePatch(patch);
    const context = this.repository.getIssueContext(issueId);
    if (context === null) {
      notFound();
    }
    assertLive(context);
    this.authorizeIssuePatch(user, context, normalized);
    if (
      normalized.type === "assignment" &&
      normalized.assigneeId !== null &&
      context.rowVersion === normalized.expectedVersion
    ) {
      this.assertReviewerExists(normalized.assigneeId);
    }
    return this.finishMutation(
      this.repository.patchIssue({ issueId: context.issueId, patch: normalized, now: this.clock() }),
    );
  }

  async patchReply(
    user: SessionUser,
    replyId: string,
    patch: ReplyBodyPatch,
  ): Promise<IssueMutationResult> {
    const normalized = this.normalizeReplyPatch(patch);
    const context = this.repository.getReplyContext(replyId);
    if (context === null) {
      notFound();
    }
    assertLive(context);
    if (context.authorId !== user.id) {
      forbidden();
    }
    return this.finishMutation(
      this.repository.patchReply({ replyId: context.replyId, patch: normalized, now: this.clock() }),
    );
  }

  async deleteIssue(
    user: SessionUser,
    issueId: string,
    expectedVersion: number,
  ): Promise<IssueMutationResult> {
    assertExpectedVersion(expectedVersion);
    const context = this.repository.getIssueContext(issueId);
    if (context === null) {
      notFound();
    }
    assertLive(context);
    if (context.authorId !== user.id && user.role !== "admin") {
      forbidden();
    }
    return this.finishMutation(
      this.repository.deleteIssue({ issueId: context.issueId, expectedVersion, now: this.clock() }),
    );
  }

  async deleteReply(
    user: SessionUser,
    replyId: string,
    expectedVersion: number,
  ): Promise<IssueMutationResult> {
    assertExpectedVersion(expectedVersion);
    const context = this.repository.getReplyContext(replyId);
    if (context === null) {
      notFound();
    }
    assertLive(context);
    if (context.authorId !== user.id && user.role !== "admin") {
      forbidden();
    }
    return this.finishMutation(
      this.repository.deleteReply({ replyId: context.replyId, expectedVersion, now: this.clock() }),
    );
  }

  private resolveContextBundle(context: IssueMutationContext): string {
    const version = this.repository.resolvePublishedVersion(context.publicVersionId);
    if (version === null || version.versionId !== context.versionId) {
      notFound();
    }
    return version.bundleHash;
  }

  private authorizeCreateMetadata(
    user: SessionUser,
    assigneeId: number | null,
    dueDate: string | null,
  ): void {
    if (user.role === "viewer") {
      if (assigneeId !== null && assigneeId !== user.id) {
        forbidden();
      }
      if (dueDate !== null) {
        forbidden();
      }
    }
  }

  private assertReviewerExists(assigneeId: number | null): void {
    if (
      assigneeId !== null &&
      !this.repository.listReviewers().some((reviewer) => reviewer.id === assigneeId)
    ) {
      throw new IssueServiceError("invalid_request", "The selected assignee does not exist.", {
        details: [{ field: "assigneeId", reason: "account does not exist" }],
      });
    }
  }

  private validateAnchor(index: BundleAnchorIndex, levelId: string, featureId: string | null): void {
    if (!index.levelIds.has(levelId)) {
      throw new IssueServiceError("invalid_anchor", "invalid_anchor", {
        details: [{ field: "anchor.levelId", reason: "level does not exist" }],
      });
    }
    if (featureId === null) {
      return;
    }
    if (!index.featureLevels.has(featureId)) {
      throw new IssueServiceError("invalid_anchor", "invalid_anchor", {
        details: [{ field: "anchor.featureId", reason: "feature does not exist" }],
      });
    }
    const featureLevel = index.featureLevels.get(featureId);
    if (featureLevel !== null && featureLevel !== levelId) {
      throw new IssueServiceError("invalid_anchor", "invalid_anchor", {
        details: [{ field: "anchor.featureId", reason: "feature belongs to a different level" }],
      });
    }
  }

  private normalizeIssuePatch(patch: IssuePatch): NormalizedIssuePatch {
    assertExpectedVersion(patch.expectedVersion);
    switch (patch.type) {
      case "body": {
        const bodyMarkdown = validateMarkdownBody(patch.bodyMarkdown);
        return {
          ...patch,
          bodyMarkdown,
          attachmentIds: resolveAttachmentIds(bodyMarkdown, patch.attachmentIds),
        };
      }
      case "assignment":
        assertAssigneeId(patch.assigneeId);
        return { ...patch };
      case "due_date":
        return {
          ...patch,
          dueDate: patch.dueDate === null ? null : validateDueDate(patch.dueDate),
        };
      case "status":
        return { ...patch };
    }
  }

  private normalizeReplyPatch(patch: ReplyBodyPatch): NormalizedReplyPatch {
    assertExpectedVersion(patch.expectedVersion);
    const bodyMarkdown = validateMarkdownBody(patch.bodyMarkdown);
    return {
      ...patch,
      bodyMarkdown,
      attachmentIds: resolveAttachmentIds(bodyMarkdown, patch.attachmentIds),
    };
  }

  private authorizeIssuePatch(
    user: SessionUser,
    context: IssueMutationContext,
    patch: IssuePatch,
  ): void {
    switch (patch.type) {
      case "body":
        if (context.authorId !== user.id) {
          forbidden();
        }
        return;
      case "assignment":
        if (user.role !== "viewer" || context.rowVersion !== patch.expectedVersion) {
          return;
        }
        if (
          (context.assigneeId === null && patch.assigneeId === user.id) ||
          (context.assigneeId === user.id && patch.assigneeId === null)
        ) {
          return;
        }
        forbidden();
      case "due_date":
      case "status":
        if (user.role === "viewer") {
          forbidden();
        }
    }
  }

  private finishMutation(result: RepositoryMutationResult): IssueMutationResult {
    if (result.type === "stale") {
      throw new IssueServiceError("stale_issue", STALE_MESSAGE, {
        current: result.current,
        revision: result.revision,
      });
    }
    const mutation: IssueMutationResult = {
      revision: result.revision,
      versionId: result.versionId,
      publicVersionId: result.publicVersionId,
      resourceId: result.resourceId,
      replayed: result.replayed,
    };
    if (!result.replayed) {
      this.publisher.publishRevision(result.publicVersionId, result.revision);
    }
    return mutation;
  }
}
