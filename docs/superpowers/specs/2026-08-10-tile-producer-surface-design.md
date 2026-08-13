# Tile producer surface — design

**Status:** approved 2026-08-10. Closes the producer half of the gap recorded in #80.

## Problem

Stage 3 (#70–#76) shipped the whole 3D Tiles path — ingestion with hostile-input
rejection, content-addressed member storage with reference-counted collection,
version-scoped serving with hash ETags, registration against the venue's own
geometry, gated activation, and a renderer that draws the result through the same
scene contract as the generated source. Every one of those slices is reachable
only by HTTP.

There is no producer surface. `POST /api/venues/:id/tiles/inspect`,
`.../registration`, and `.../activate` have no caller; `src/gallery/tileGates.ts`
holds the bilingual gate copy #74 asked for and nothing imports it. A producer
cannot upload a 3D Tiles package, read its registration residuals, classify
contextual geometry, or activate a package without `curl`.

`d160ddd` closed the *viewer* half — a 2D/3D toggle and an "Open in 3D" gallery
action. This closes the producer half.

## What already exists

The server contract is complete and is not changing:

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /api/venues/:venueId/tiles/inspect` | multipart `file` | `201 {packageId, sourceHash, rootTileset, assetVersions[], extensions[], ignored[], totalBytes, members[{path,hash,byteSize,contentType,kind,reused}]}` |
| `POST /api/venues/:venueId/tiles/:packageId/registration` | `{capabilityProfile?, contextualSourceObjects?[], profile?}` | `200 {state, report, floorMappings, gates[{code,subject,measured,band}]}` |
| `POST /api/venues/:venueId/tiles/:packageId/activate` | — | `202 {jobId, versionId, seq}` |
| `DELETE /api/venues/:venueId/tiles/:packageId` | — | `204`; `409 package_in_use` |

`TileRegistrationReport` (`server/src/core/native.ts`) already carries everything
a producer needs to decide: `venueWide` residual stats, per-`floors` stats with
`medianShiftM` and `coherentClusters`, per-`levels` `resolvedPlaneM` beside
`metadataElevationM` with their `metadataDifferenceM`, `unmappedLevels`, and the
`appliedVerticalOffsetM`. No new measurement is needed — only a surface.

## Two server additions

Both exist because the server already knows the answer and has no way to say it.

**1. `GET /api/venues/:venueId/tiles`** — the venue's packages, each with its
stored evaluation and activation state. Producer session, like its siblings.

Without it the flow is single-session: `packageId` lives only in React state, so
a reload orphans an upload whose recovery is re-sending up to 172 MiB. The rows
are already there (`tile_packages`, `tile_activations` with its
`UNIQUE (package_id, evaluated_version_id)`), and `findEvaluation` already reads
them for activation.

Response, one entry per package, newest first:

```ts
{
  packages: Array<{
    packageId: number;
    sourceHash: string;
    rootTileset: string;
    assetVersions: string[];
    extensions: string[];
    ignored: string[];
    totalBytes: number;
    memberCount: number;
    createdAt: string;
    /** Absent until registration has run against the current published version. */
    evaluation: {
      state: "evaluated" | "activated";
      /** False when the venue has published since; the numbers describe other geometry. */
      current: boolean;
      capabilityProfile: string | null;
      profileId: string;
      profileVersion: number;
      report: TileRegistrationReport;
      gates: TileActivationGate[];
      evaluatedAt: string;
      activatedAt: string | null;
    } | null;
    /** True when a *published* version serves this package. */
    serving: boolean;
  }>;
}
```

`current` is computed the way `activate` computes it: compare the stored
`evaluated_version_id` and `evaluated_bundle_hash` against `evaluationTarget`.
The client must not re-derive that rule — a second copy of it would be a second
answer to "may this activate".

**2. `VenueSummary.tiles`** — beside the existing `hasNetwork` / `hasGraph`:

```ts
tiles?: { packages: number; activeOnLatest: boolean };
```

`activeOnLatest` joins `version_tile_packages` against the venue's latest
published version — the same link serving and collection use. The gallery needs
it to chip a venue and to say which source "Open in 3D" will actually get.

## The flow

Registration is a loop, not a step. Gates name subjects, and the contract gives a
producer exactly three levers before re-evaluating.

```
upload ──▶ registration ──gates──▶ levers ──re-evaluate──▶ registration
                │                (offset / bands / classify)
                └──no gates──▶ activate ──▶ new published version
```

`TilePackageDialog.tsx`, following `GdbImportDialog`'s phase model:

- **upload** — pick or drop the archive; XHR with upload progress, because 172 MiB
  over a LAN is a minute, not a spinner. On acceptance, show what was accepted:
  root tileset, asset versions, member count, total bytes, how many members the
  store already held (dedup is a real producer signal on a second upload), and
  every ignored entry. An entry the graph never references is worth naming — it is
  usually an export mistake.
- **registration** — the report, then the verdict:
  - venue-wide residuals: samples, p50, p90, max;
  - per floor: canonical id, its composite source levels, sampled and carved-out
    counts, p50/p90/max, `medianShiftM`, and each coherent cluster's offset and
    distance;
  - per level: `resolvedPlaneM` beside `metadataElevationM`, with
    `metadataDifferenceM` shown when they disagree. This is the KITTE 3.02 m
    finding as a number in front of the person who exported it;
  - `unmappedLevels` named explicitly, because #74 fails that gate rather than
    guessing;
  - every gate through `tileGateMessage`, which prints the measurement beside the
    band it failed.
- **activate** — enabled only when `gates` is empty and the evaluation is
  `current`; `202` then `api.waitForJob`, then reload the gallery, because a new
  version was published.

### The three levers

Exactly what the contract accepts, and nothing invented:

1. **`verticalOffsetM`** — the datum decision #74 refuses to infer. One number,
   applied to tile planes before matching.
2. **`floorP90MaxM`** per canonical floor — editable, with the floor's *measured*
   p90 shown beside the band it must clear. A producer widening 0.50 m to 0.95 m
   is choosing to ship that floor, and the design's answer is to make the number
   they are overriding impossible to miss rather than to hide the control.
3. **`contextualSourceObjects`** — a checkbox per source object named by an
   `unclassifiedOpaqueContent` gate. Opaque geometry belonging to no floor is
   either context or a mistake, and only the producer knows which.

Re-evaluating re-POSTs `registration`, which replaces the stored evaluation
rather than accumulating one.

## Errors

Every documented code gets bilingual copy: `file_required`, `venue_not_found`,
`package_not_found`, `package_in_use`, `no_published_version`, `not_evaluated`,
`evaluation_stale`, `activation_blocked`, plus `bridge_error` / `internal_error`
and the ingestion rejections the validator raises for a package that escapes
itself. `activation_blocked` carries `details.gates`, so it renders through the
same `tileGateMessage` path as an evaluation's own gates — one presentation of a
gate, not two.

`no_published_version` is not a failure but a precondition: registration measures
against the venue's own canonical data, and there is none until something is
published. The dialog says so plainly instead of offering a retry.

## Testing

- **Server:** the list route — packages with and without evaluations, `current`
  false after republishing, `serving` true only for a published version, producer
  session required, venue scoping (a package of another venue is not listed).
- **Client:** dialog phases against a mocked API; gate rendering in both locales;
  the levers producing the exact request body; `activation_blocked` rendering the
  gates it returns; the report's numbers appearing where the report says.
- **Browser:** the whole loop on a real server —
  `server/test/tileRegistrationFixtures.ts` builds both a well-registered
  (`corridorPackageGlb(0)`) and a deliberately misregistered
  (`corridorPackageGlb(inset)`) package, so one test can trip a gate, apply a
  lever, re-evaluate, and activate.

## Non-goals

- No new measurement, profile semantics, or gate. The Rust core is untouched.
- No recorded justification for a widened band. It was considered and declined:
  it needs a column and a policy, and #80 can carry it if a real producer wants
  an audit trail.
- No package browser beyond the venue's own list. Cross-venue tile management is
  not a thing anyone has asked for.
