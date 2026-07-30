# Kiriko Phase Three: Version-Pinned Review Issues

**Date:** 2026-07-18  
**Status:** Approved; amended for rich comments and first-party attachments
**Depends on:** Phase Two immutable KVB publication and dataset viewer cutover

## 1. Context

Kiriko already publishes immutable venue versions and renders dataset-backed viewers from KVB bundles. Phase Three adds the review workflow described by the product architecture: map-pinned feedback, a discussion thread, and a small issue queue attached to the exact published venue version under review.

A root thread is presented as a **review issue**, not a generic comment. It has a map anchor, status, optional assignee, optional due date, and one chronological level of replies. The workflow remains intentionally smaller than a project-management system.

Issue state is server-side mutable data. KVB blobs remain immutable and contain no comments, users, assignments, or deadlines.

## 2. Goals

Phase Three ships one complete vertical slice:

- Public read access to review issues on normal published dataset viewers.
- Session-authenticated creation, replies, edits, deletion, assignment, deadline changes, and status transitions.
- Pins synchronized with the current floor and the selected issue.
- An Issues rail panel with active, assigned-to-me, unassigned, and closed views.
- One optional assignee, immutable creation date, visible update date, and one optional date-only due date per root issue.
- Canonical Markdown rendered safely, with first-party raster image attachments.
- Version-pinned history: publishing a new venue version starts with an empty issue collection.
- Near-real-time updates through server-sent event invalidations and canonical REST refetches.
- End-to-end coverage across server, viewer, and two concurrent browser contexts.

## 3. Non-goals

Phase Three does not add:

- Mentions, notifications, email, presence, typing indicators, or read receipts.
- Reactions, stored rich-text/editor JSON, WYSIWYG editing, or arbitrary HTML/MDX.
- Remote images, data URLs, SVG, or media embedded in KVB/local ZIP/export/carry-forward.
- Nested replies beyond one root plus one reply level.
- Issue transfer or automatic carry-forward to a newly published venue version.
- Routing, positioning, or KVB schema changes.
- Comments in `?embed=1`, explicit `?src=` viewers, dropped/local ZIP viewers, or unpublished versions.
- Anonymous writes or a separate guest identity system.
- Bulk issue editing, boards, labels, priorities, estimates, or recurring deadlines.
- A new tenant-membership model. The existing account and role model remains authoritative.

## 4. Product and interaction model

### 4.1 Viewer availability

Issues load only when all of the following are true:

1. The viewer was opened through the dataset/KVB path.
2. The viewer is not in `?embed=1` mode.
3. The KVB venue finished loading successfully and its HTTP response supplied a valid `Kiriko-Version-Id`.

The current `?dataset=` viewer fetches a latest-bundle alias, so neither the query slug nor decoded `(datasetId, version)` pair is a permanent identity: venue deletion and slug recreation can reuse both. Every version row therefore has a non-reusable public version ID, and both latest and pinned bundle responses expose the exact row’s ID through `Kiriko-Version-Id`. `loadKirikoBundle` returns the hydrated venue together with that response identity and the decoded bundle metadata. App stores the public version ID beside the successful load and derives the issue URL from it. A missing/invalid identity disables issues with a localized issue-specific error but does not fail the venue. Local ZIP and explicit-source results carry no issue provenance and never create issue API or SSE requests.

### 4.2 Rail and queue

The existing icon rail gains an **Issues** entry. Its badge counts active (`open` plus `in_review`) issues across every floor in the current venue version.

The 320 px floating panel provides these views:

- **Active:** `open` and `in_review`, default.
- **Assigned to me:** active issues assigned to the signed-in account.
- **Unassigned:** active issues with no assignee.
- **Closed:** closed issues and deleted-root tombstones.

Rows show stable pin number, summary, status, floor, optional feature context, reply count, assignee, and due date. Summary is the first non-empty normalized Markdown source line with whitespace collapsed; keep its first 80 Unicode scalar values and append `…` if and only if it is longer. A deleted root uses **Comment deleted**. Overdue and due-soon styling is supplementary to text; color is never the only signal.

Closed issues and their map pins are hidden by default. They remain filterable. A non-deleted closed issue may be reopened by a member or admin.

### 4.3 Stable pins and floor behavior

Every root issue receives a monotonically increasing pin number within its venue version. Numbers are never reused after closure or deletion.

Pins are rendered only for roots on the active floor and currently included by the panel filter. Selecting a pin opens the matching issue. Selecting a queue row switches to its floor, centers its coordinates, opens the issue, and highlights its optional feature when that feature is still present.

Every root stores:

- `levelId`
- longitude and latitude
- optional `featureId`

Coordinates and floor are required. A feature under the placement click is attached when available and can be removed before posting.

### 4.4 Creating an issue

“New issue” enters placement mode. The next valid map click captures the current floor, WGS84 coordinate, and optional rendered feature. The panel then shows:

- Markdown body in the shared Write/Preview editor, with formatting and image controls
- Optional assignee
- Optional due date
- Captured floor/coordinate
- Optional feature context

Assignment and due date never block creation. The image control supports file picking, clipboard paste, and drag/drop with progress, retry/cancel, editable alt text, and staged thumbnails; accepted formats and budgets are owned by `docs/issue-attachments-operations.md`. A viewer-role author may leave the issue unassigned or assign it to themselves; members/admins may choose any existing account. If sign-in is required after the draft begins, placement, text, and permitted metadata survive the sign-in flow.

Creation time and author are assigned by the server and cannot be edited.

### 4.5 Issue detail and discussion

The detail view shows root text and first-party images, status, assignee, due date, created date/author, updated date, anchor context, and chronological replies. Root/reply create and edit use the same native-textarea Write/Preview editor; its preview uses the production renderer. Replies are one level deep and contain only author, Markdown body and attachments, edit/deletion state, and timestamps.

Deleted content is rendered as **Comment deleted**. Replies, root metadata, pin history, and timestamps remain visible. Deleting a root permanently closes it; a deleted root cannot be reopened.

Signed-in users may add replies to open, in-review, or closed roots. A member/admin does not need to reopen an issue merely to continue its discussion. A deleted root rejects new replies with `409 issue_deleted`; the reply-creation transaction rechecks `deleted_at` so a concurrent root deletion cannot admit a late reply. Existing replies remain editable/deletable under the normal authorship rules even when their root is closed or deleted.

### 4.6 Date semantics

A due date is an ISO calendar date (`YYYY-MM-DD`), not a timestamp. It is stored and transported unchanged, avoiding hidden time-zone conversion. The client localizes its display and compares calendar components in the viewer’s local time: a date before today is overdue; today through three local calendar days ahead is due soon. The API does not persist derived `overdue` or `dueSoon` flags.

## 5. Permissions

| Capability | Anonymous | Viewer | Member | Admin |
|---|---:|---:|---:|---:|
| Read issues in a normal published viewer | Yes | Yes | Yes | Yes |
| Open the public SSE stream | Yes | Yes | Yes | Yes |
| Create an issue or reply | No | Yes | Yes | Yes |
| Edit own issue/reply body | No | Yes | Yes | Yes |
| Soft-delete own issue/reply | No | Yes | Yes | Yes |
| Self-assign an issue | No | Yes | Yes | Yes |
| Assign another account | No | No | Yes | Yes |
| Set or change due date | No | No | Yes | Yes |
| Change status or reopen | No | No | Yes | Yes |
| Soft-delete any issue/reply | No | No | No | Yes |

Members and admins cannot rewrite another author’s text. Administrative moderation uses the tombstone delete operation instead.

A viewer may assign themselves only when an issue is unassigned, and may clear the assignment only when they are the current assignee. A viewer cannot replace or clear another account’s assignment. Members/admins may assign or clear any existing account. The same transition rules apply during root creation, where the only viewer-role choices are unassigned or self.

Issue routes use the exact error contract in Section 8.1. A signed-out draft opens the existing sign-in modal without discarding local draft state.

## 6. Data model

The original phase adds one migration that backfills permanent public identities and creates the issue tables. Rich comments add an additive attachment migration; the authoritative storage and lifecycle contract is `docs/issue-attachments-operations.md`.

### 6.1 Public version identity

Add `versions.public_id`, a unique, non-null 256-bit lowercase hexadecimal token. The migration backfills existing rows with SQLite `randomblob(32)` values; new versions use Node `crypto.randomBytes(32)`. The API validates the exact `[0-9a-f]{64}` form. A value is never reused, including after hard deletion. Latest and pinned `/v/:tenant/:venue/bundle` responses emit the resolved row’s value in `Kiriko-Version-Id`.

Issue lookups use only this public ID. If a venue is deleted, its versions and issues cascade away and the old ID returns `404` forever; recreating the same tenant/venue slug and sequence creates a different public ID. Bundle hashes cannot substitute for this identity because identical bytes may be republished as a distinct review version. The KVB bytes and golden fixture remain unchanged.

### 6.2 `comment_state`

One row per published venue version:

| Column | Type | Invariant |
|---|---|---|
| `version_id` | INTEGER PRIMARY KEY | Foreign key to venue version; cascade delete |
| `revision` | INTEGER NOT NULL | Starts at 0; increments once per committed mutation |
| `next_pin_number` | INTEGER NOT NULL | Starts at 1; incremented atomically when a root is created |

The state row is created lazily in the same transaction as the first read or write. Pin allocation uses `UPDATE ... RETURNING`, not `MAX(pin_number) + 1`.

### 6.3 `comments`

| Column | Type | Invariant |
|---|---|---|
| `id` | TEXT PRIMARY KEY | Opaque server-generated identifier |
| `version_id` | INTEGER NOT NULL | Published venue version; cascade delete |
| `parent_id` | TEXT NULL | Null for root; otherwise references a root in the same version |
| `author_id` | INTEGER NOT NULL | Existing user |
| `create_request_id` | TEXT NOT NULL | Client-generated UUID v4 used for idempotent root/reply creation |
| `create_request_hash` | TEXT NOT NULL | SHA-256 of the canonical operation, target, and create payload |
| `pin_number` | INTEGER NULL | Required and unique per version for roots; null for replies |
| `level_id` | TEXT NULL | Required for roots; null for replies |
| `longitude` | REAL NULL | Required finite WGS84 value for roots |
| `latitude` | REAL NULL | Required finite WGS84 value for roots |
| `feature_id` | TEXT NULL | Optional for roots; null for replies |
| `body_markdown` | TEXT NULL | Non-empty unless soft-deleted |
| `status` | TEXT NULL | Root only: `open`, `in_review`, or `closed` |
| `assignee_id` | INTEGER NULL | Root only; existing user; delete sets null |
| `due_date` | TEXT NULL | Root only; exact ISO calendar date |
| `row_version` | INTEGER NOT NULL | Starts at 1 and increments on mutation |
| `created_at` | TEXT NOT NULL | Application-generated UTC RFC 3339 timestamp; immutable |
| `updated_at` | TEXT NOT NULL | Application-generated UTC RFC 3339 timestamp |
| `deleted_at` | TEXT NULL | Application-generated UTC RFC 3339 soft-delete timestamp |

Database checks enforce root/reply field separation, valid statuses, body/tombstone consistency, coordinate ranges, unique `(version_id, pin_number)`, and unique `(author_id, create_request_id)`. Foreign keys and repository checks additionally verify that a reply’s parent belongs to the same version and is a root before insertion.

Root and reply creation require a client-generated UUID v4 `requestId`. The SHA-256 input is a canonical JSON object with sorted keys and explicit nulls for absent optionals. A root hash includes `{ assigneeId, attachmentIds, bodyMarkdown, dueDate, featureId, kind: \"root\", latitude, levelId, longitude, versionId }`; a reply hash includes `{ attachmentIds, bodyMarkdown, kind: \"reply\", parentIssueId, versionId }`. IDs are the server-resolved database IDs, attachment IDs are sorted and unique (an empty array when absent), and Markdown uses the newline-normalized value that will be stored. This binds a key to its operation and exact target. Replaying the same request ID as the same author with the same hash returns the existing resource ID and current collection revision without allocating a pin, inserting a row, incrementing revision, or broadcasting SSE. Reusing that ID with a different hash returns `409 idempotency_conflict`.

Every successful, non-replayed mutation updates the affected row and increments `comment_state.revision` in one SQLite transaction. SSE publication occurs only after commit.

Canonical GET reads `comment_state`, roots, and replies inside one SQLite read transaction so its revision and projection describe the same snapshot.

## 7. Public REST projection

The canonical collection response is:

```ts
interface IssueCollection {
  revision: number
  issues: ReviewIssue[]
}

interface ReviewIssue {
  id: string
  pinNumber: number
  rowVersion: number
  anchor: {
    levelId: string
    longitude: number
    latitude: number
    featureId?: string
  }
  bodyMarkdown: string | null
  attachments: IssueAttachmentMetadata[]
  status: 'open' | 'in_review' | 'closed'
  author: ReviewerSummary
  assignee: ReviewerSummary | null
  dueDate: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  replies: IssueReply[]
}

interface IssueReply {
  id: string
  rowVersion: number
  bodyMarkdown: string | null
  attachments: IssueAttachmentMetadata[]
  author: ReviewerSummary
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

interface IssueAttachmentMetadata {
  id: string
  contentType: 'image/png' | 'image/jpeg' | 'image/webp'
  width: number
  height: number
  thumbnailWidth: number
  thumbnailHeight: number
}

interface ReviewerSummary {
  id: number
  username: string
}

```

Every `createdAt`, `updatedAt`, and `deletedAt` wire value is UTC RFC 3339 with a trailing `Z`, emitted exactly from the stored application-generated value. Clients never parse SQLite’s space-separated `datetime('now')` format. `dueDate` remains the unchanged date-only value.

The list is sorted by pin number and replies by creation time plus ID as a deterministic tie-breaker. A deleted resource returns `bodyMarkdown: null`, an empty `attachments` array, and its tombstone timestamp; deleted text and media are never returned publicly.

## 8. HTTP and SSE API

Version-scoped routes live under the dynamic `/api` namespace; `/v/` remains the static, cacheable bundle namespace defined by the platform architecture. The client uses the non-reusable identity from the exact loaded bundle response rather than database IDs, slugs, sequences, or bundle hashes:

```text
GET    /api/review/versions/:publicVersionId/issues
POST   /api/review/versions/:publicVersionId/issues
GET    /api/review/versions/:publicVersionId/issues/events
GET    /api/reviewers
POST   /api/issues/:issueId/replies
PATCH  /api/issues/:issueId
PATCH  /api/replies/:replyId
DELETE /api/issues/:issueId
DELETE /api/replies/:replyId
POST   /api/review/versions/:publicVersionId/issue-attachments
DELETE /api/issue-attachments/:attachmentId
GET    /api/issue-attachments/:attachmentId/content
GET    /api/issue-attachments/:attachmentId/thumbnail
```

The version-scoped GET and event stream are public only while that exact public ID resolves to a published version. There is intentionally no mutable “latest issues” alias. Collection, reviewer, and mutation JSON responses set `Cache-Control: no-store`; SSE uses its separate no-cache stream headers. Every mutation and reviewer-directory request requires a valid session. The mutation service resolves each opaque issue/reply ID back to its version and rechecks publication state and role permissions.

Create accepts `requestId` plus root body, anchor, optional assignee, optional due date, and optional `attachmentIds`. Reply create and body patches likewise accept optional `attachmentIds`. When omitted, the server derives IDs from canonical `attachment:<id>` image tokens for old-client compatibility; when present, the field must have exact set equality with those tokens. Binding/detaching is transactional with the body mutation. Attachment upload is authenticated multipart with one `file` and UUID-v4 `requestId`; retries by the same uploader are idempotent only for identical bytes and the same version. Patch is a typed discriminated operation for exactly one of:

- body edit
- assignment change
- due-date change
- status change

Every patch/delete includes `expectedVersion`. Successful mutations return `{ revision, resourceId }`; they do not return or partially replace canonical collection state. The client treats `revision` as an observed invalidation and refetches the collection. A stale row version returns `409 stale_issue` with the current resource so the client can preserve its draft and reconcile explicitly.

An unknown/unpublished public version ID or an unknown/cross-version resource returns `404 not_found`.

### 8.1 Error contract

Issue APIs extend the existing flat `error` code without changing gallery callers:

```ts
interface IssueApiError {
  error:
    | 'invalid_request'
    | 'invalid_anchor'
    | 'invalid_due_date'
    | 'invalid_markdown'
    | 'invalid_attachment'
    | 'unauthorized'
    | 'forbidden'
    | 'quota_exceeded'
    | 'not_found'
    | 'stale_issue'
    | 'idempotency_conflict'
    | 'issue_deleted'
    | 'rate_limited'
    | 'sse_capacity'
    | 'internal_error'
  message: string
  details?: Array<{ field: string; reason: string }>
  current?: {
    kind: 'issue' | 'reply'
    value: ReviewIssue | IssueReply
  }
  revision?: number
}
```

`400` uses the validation codes and optional field details; `401 unauthorized`, `403 forbidden` or `quota_exceeded`, and `404 not_found` do not expose private resource existence; `409` uses the three conflict codes and includes `current`/`revision` only for `stale_issue`; `429 rate_limited` rejects excess uploads; `500 internal_error` covers unexpected database, blob, and native/storage failures without exposing internals; `503 sse_capacity` includes `Retry-After: 15`. Fastify TypeBox response schemas and the issue client preserve this exact shape.

### 8.2 SSE event contract


The event stream uses a single event shape:

```text
event: revision
data: {"revision":42}
```

Each connection immediately emits the current revision, then a `: heartbeat` comment every 15 seconds and committed revision events. The stream does not send issue bodies or mutation deltas. No event log or `Last-Event-ID` replay store is required because every event is only an invalidation signal.

The server removes listeners on socket close and removes per-version fan-out state after its last subscriber. It accepts at most 512 issue SSE connections process-wide and 128 for one venue version; both limits are configurable. A connection that would exceed either limit is rejected before listener allocation with `503 sse_capacity` and `Retry-After: 15`. Tests prove capacity is released after disconnect.

## 9. Bundle-backed anchor validation

The server must not trust client-provided level or feature IDs. Extend `@kiriko/node` with one asynchronous inspection operation backed by the existing Rust KVB decoder. It returns a compact anchor index:

- Valid level IDs.
- Feature ID to optional level ID mapping.
- Bundle identity needed to prove the inspected bytes match the version’s `bundle_hash`.

No KVB envelope or section changes are required. The server reads the immutable bundle blob, verifies its content-addressed identity, inspects it off the Fastify event loop, and caches the resulting index by bundle hash in a small bounded process-local LRU.

Root creation rejects:

- Unknown level.
- Unknown optional feature.
- A level-specific feature attached to a different level.
- Non-finite or out-of-WGS84 coordinates.

The pin is not required to fall inside the feature geometry; point placement and optional feature context are separate concepts.

## 10. Markdown safety

Before storage and idempotency hashing, the server converts CRLF and bare CR to LF. It rejects unpaired UTF-16 surrogates, whitespace-only bodies, and bodies outside 1–4,000 Unicode scalar values after newline normalization. The only permitted C0/C1 controls are LF (`U+000A`) and tab (`U+0009`); `U+0000–0008`, `U+000B–001F`, and `U+007F–009F` are rejected. Leading/trailing whitespace in an otherwise non-empty body is preserved. The web composer mirrors these limits for immediate feedback, but the server remains authoritative.

The server stores that normalized Markdown. The web app renders with a Markdown component that:

- Does not enable raw HTML parsing.
- Allows paragraphs, line breaks, emphasis, strong text, ordered/unordered lists, links, and inline code.
- Renders images only for canonical `attachment:<id>` tokens resolved against attachment metadata projected with that body; remote, relative, data, unknown, and SVG sources render no image.
- Does not render iframes, other embedded media, tables, headings, or executable HTML.
- Allows only safe `http`, `https`, and `mailto` link protocols.
- Adds safe external-link attributes.

Plain text remains readable without Markdown. Every root/reply create and edit surface uses the shared native-textarea editor with accessible bilingual Bold, Italic, Inline code, Bulleted, Numbered, Link, and Image controls plus single-pane Write/Preview tabs. Preview uses this exact production renderer; editor state is never persisted.

## 11. Client state and synchronization

The issue subsystem is independent from venue loading and the main viewer reducer. Its state includes:

- Current canonical collection and `appliedRevision`.
- `highestObservedRevision`.
- At most one in-flight refetch.
- Panel filter and selected issue.
- Placement/composer draft.
- Stale/error/reconnecting flags.

On SSE connect or event, the client records the maximum observed revision. It starts a GET only when the observed revision exceeds the applied revision and no GET is running. A GET response may replace the collection only when its revision is not below the currently applied revision. If its revision is below the highest observed revision, another GET begins immediately.

This produces these invariants:

- Duplicate and out-of-order SSE events are harmless.
- A mutation committed during disconnect cannot be missed after reconnect.
- Bursts coalesce without losing the final state.
- An older GET response never overwrites a newer projection.

Mutations are not optimistically committed to canonical state. Controls show a pending state. A successful mutation response records its revision only in `highestObservedRevision` and triggers a full collection GET; only that GET may advance `appliedRevision`. This prevents a local revision 7 response from hiding an unseen concurrent revision 6 mutation. A `409` preserves unsaved input, records the returned revision as observed, refetches canonical data, and shows a specific conflict message.

When App changes venue provenance or decoded KVB version, it closes the previous stream, clears the previous collection and selection, then initializes the exact new pinned version. Late responses from the old version are ignored through the same load-attempt identity used by the bundle loader.

## 12. Error handling

Issue failures are localized:

- Initial GET failure: panel error with Retry; map and venue controls remain functional.
- SSE failure: existing data remains visible with a reconnecting/stale indicator; browser reconnection plus the initial revision event recovers state.
- Mutation network failure: retain composer text and metadata. POST retries reuse the original `requestId`; patch/delete retries reuse `expectedVersion`.
- `401`: open sign-in while preserving the draft.
- `403`: explain the denied action and restore server state.
- `409 stale_issue`: preserve the draft, treat the returned revision as observed, refetch, and require explicit retry.
- Invalid or removed feature reference during an old draft: keep the coordinate and floor, remove stale feature attachment, and ask the user to submit again.
- Deleted selected issue after remote invalidation: return to queue with a tombstone notice rather than leaving a broken detail view.

No issue API error is converted into a generic archive/bundle load error.

## 13. Accessibility and responsive behavior

- Rail entry, filter controls, pins, issue rows, status changes, assignment, and composer are keyboard operable.
- Pins have accessible names including pin number, summary, status, and floor.
- Selection is represented through ARIA state as well as color.
- Focus moves into the composer after map placement and returns to the initiating control on cancel.
- Opening sign-in from a draft returns focus to the draft after successful authentication.
- Status, due-soon, and overdue indicators include text labels.
- Attachment thumbnails have meaningful alt text and open an accessible modal lightbox that traps focus, makes the background inert, closes with Escape, and returns focus to its trigger.
- At narrow widths, the floating panel becomes the existing mobile sheet pattern; the map remains available behind it.
- `prefers-reduced-motion` removes nonessential pin/panel transitions.

## 14. Verification strategy

### 14.1 Server and database

Focused tests cover:

- Migration constraints and cascades.
- Transactional, non-reused pin numbering.
- Root/reply field separation and one-level threading.
- Public read and authenticated-write boundaries.
- Exact author/member/admin permission matrix.
- Assignment, self-assignment, due-date, and status rules.
- Viewer self-assignment transitions for unassigned, self-assigned, and other-assigned roots.
- Idempotent root/reply replay after a committed response is lost, mismatched payload reuse, root-versus-reply reuse, and same-body reuse against a different version or parent.
- Reply creation on closed roots and rejection before/after a concurrent root deletion.
- Markdown newline normalization, Unicode-scalar/whitespace/control boundaries, plus coordinate, level, and feature validation.
- Tombstones that never return deleted text.
- Row-version conflict responses.
- Collection revision increments only after successful commits.
- Immediate SSE revision, committed invalidation, disconnect cleanup, and heartbeat behavior.
- Global/per-version SSE capacity rejection and capacity release after disconnect.
- Unknown, unpublished, and cross-version resources.
- Permanent public-version ID backfill/generation, bundle response headers, hard-delete/recreate slug reuse, and old-ID `404` behavior.
- RFC 3339 UTC timestamp storage/wire values under a non-UTC process time zone, while due dates remain unchanged.

### 14.2 Rust/native boundary

Tests cover exact KVB anchor-index extraction, corrupt-bundle error mapping, feature-to-level relationships, Node event-loop responsiveness, and cache identity by bundle hash. Existing golden KVB bytes remain unchanged.

### 14.3 Web unit/integration

Tests cover:

- Dataset-only issue initialization and zero issue calls for embed/local/source paths.
- Queue filtering and active badge counts.
- Current-floor pin projection and row-triggered floor changes.
- Placement, feature attachment/removal, and draft restoration after sign-in.
- Markdown rendering and unsafe HTML/protocol suppression.
- Role-controlled assignment, deadline, status, edit, and delete controls.
- Date-only localized/overdue display.
- Monotonic revision reducer, burst coalescing, stale GET suppression, reconnect mismatch, and old-version response suppression.
- Mutation revision interleaving where an unseen remote revision precedes the local successful mutation.
- Retryable API and mutation errors without venue-load failure.
- Keyboard focus and accessible state.

### 14.4 Browser acceptance

Playwright exercises:

1. A signed-in user opens a published KVB dataset, places a pin, creates an issue, assigns it, sets a due date, replies, changes status, closes it, filters closed issues, and reopens it.
2. Two browser contexts view the same version; a mutation in one appears in the other through SSE invalidation and REST refetch.
3. Publishing a new version yields an empty issue collection while the previous version retains its history.
4. One context keeps an already-loaded venue open while that venue is deleted and its slug/sequence is recreated; the old public version ID can neither read nor mutate the replacement.
5. Embed, explicit-source, and dropped-file viewers make no issue requests.
6. Local ZIP viewing and the Phase Two KVB route remain functional, and bundle bytes remain unchanged when the identity header is added.

## 15. Completion criteria

Phase Three is complete only when:

- The public-version migration/header, repository, services, REST routes, SSE stream, native anchor inspection, Issues rail UI, map pins, and composer work end to end.
- All role, version, concurrency, Markdown, tombstone, and anchor invariants above are enforced server-side or at the explicitly named rendering boundary.
- Issue failures cannot break venue loading.
- Normal dataset viewers update across two browser contexts without polling.
- Local ZIP, explicit-source, and embed paths remain issue-free and operational.
- Focused Rust, server, web, and browser acceptance commands pass with no generated bindings committed.
