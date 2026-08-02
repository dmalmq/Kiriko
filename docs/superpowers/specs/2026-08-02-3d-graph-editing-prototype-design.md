# 3D graph-editing prototype design

**Status:** Approved for throwaway prototyping on `prototype/graph-editing-model`

**Wayfinder question:** [Choose the full 3D graph-editing model](https://github.com/dmalmq/imdf-map-application/issues/27)

## Purpose

Build one disposable browser prototype that tests whether producers can repair and edit a vertically placed routing graph in an exploded indoor scene without silently changing floor, elevation, or conveyance meaning.

The prototype answers an interaction and state-model question. It does not select the production renderer, change graph persistence, or implement a production editor.

## Locked upstream decisions

The prototype must preserve these decisions rather than reopen them:

- Ordinary junctions are assigned to and normally constrained to a resolved floor plane.
- Source elevation, normalized scene elevation, provenance, and producer overrides remain distinct.
- Vertical connectors have floor-anchored endpoints and may have producer-edited interior XYZ control points.
- Structurally invalid graphs are rejected; semantic Defect, Review, and Advisory findings are non-blocking.
- Scene and panel selection refer to the same stable graph/finding identities.
- A complete Check precedes save; production save creates a new immutable venue version.
- Full graph editing is producer-only and desktop-only.

## Approved product choices

The user selected:

1. **Finding-first repair** as the workspace entry posture.
2. **Constrained handles** rather than free XYZ dragging or form-only editing.
3. **Tiered constrained snapping** using provisional 0.50 m and 3.0 m bands.
4. **Endpoints, then association** for cross-floor connector creation.
5. **A — Synchronized repair cockpit** as the workstation composition.

The earlier visual comparison also rejected a scene-only HUD as too weak for queue/evidence traceability and a guided wizard as too slow for expert bulk repair. The interactive code prototype therefore implements only the selected cockpit instead of rebuilding the rejected layouts.

## Workspace composition

### Findings queue — left

The workspace opens on the highest-priority open finding. The queue groups Defect, Review, and Advisory findings and shows confidence, affected floors, and exception state. Selecting a row:

- selects the finding without mutating graph state;
- selects its primary graph object;
- focuses the same graph and venue evidence in the scene;
- populates the inspector with measured evidence and available actions.

The queue stays visible so producers can move among findings without entering a wizard.

### Exploded scene — center

The synthetic scene presents B1 and 1F as stable, separated floor planes. Each plane always shows its floor identity and resolved scene elevation. The active evidence remains bright; unrelated graph and venue context fades but does not disappear.

A compact scene toolbar keeps Kiriko's existing concepts: Select, Add, Connect, Delete, Undo, and Redo. Floor and camera controls are secondary. The scene is schematic SVG/CSS, not MapLibre, WebGL, or 3D Tiles; renderer feasibility belongs to a separate Wayfinder decision.

### Selection inspector — right

The inspector is the authority for meaning that cannot be inferred safely from a pointer gesture. It shows:

- stable graph and finding identity;
- assigned floor and resolved floor-plane elevation;
- original source altitude/datum and normalized scene Z;
- provenance and any producer override;
- connector endpoints and interior control points;
- conveyance association candidate and confidence;
- snap source, distance, band, and ambiguity;
- finding evidence, measured tolerance, and before/after values;
- staged action and local finding delta.

Geometry, floor reassignment, association confirmation, accepted exceptions, and validation-profile overrides are explicit inspector actions. No radial menu or opaque context gesture carries domain meaning.

## Editing interactions

### Select

Picking a junction, edge, connector, control point, venue conveyance, or finding selects a stable semantic identity. Junctions win ties over edges. Occluded evidence remains selectable from the findings queue and inspector even when scene picking is unavailable.

### Add ordinary junction

The producer activates Add and chooses a labelled floor plane before placing the point. The new junction receives that floor identity and its resolved scene Z. It cannot land between floors. The inspector previews source/provenance fields and any same-floor snap before commit.

### Move ordinary junction

A selected ordinary junction exposes one floor-plane handle. Dragging changes only local XY. Its floor, floor-plane scene Z, and source altitude remain unchanged.

Changing the assigned floor is a separate inspector action. It shows old/new floor identities and scene elevations, preserves the original source altitude, requires confirmation, and recomputes the source-versus-plane finding after commit.

### Connect

Selecting two nodes on the same floor previews an ordinary edge and commits it when structurally valid.

Selecting endpoints on different floors creates a connector draft rather than an ordinary edge. The draft records explicit start and end floor identities, then asks the producer to:

1. confirm one conveyance candidate or leave the connector visibly unassociated;
2. accept the straight endpoint path or add interior XYZ handles for turns and landings;
3. inspect rise/run, monotonicity, footprint evidence, and direction/accessibility semantics;
4. commit the connector as one history entry.

Endpoint handles remain constrained to their declared floor planes. Interior handles are not floor-assigned junctions: they move through explicit XYZ axes with a visible numeric scene Z and provenance.

### Delete

Delete acts on one selected graph object. Venue geometry and conveyance evidence remain read-only, so Delete is disabled when either is selected. Before commit, the inspector shows incident edges, affected findings, connector association consequences, and whether deletion would violate a structural invariant. A valid delete is one history entry; a structural-invalid delete is rejected without mutation.

### Cancel

Escape or Cancel exits Add, Move, Connect, exception, and profile-override drafts without adding a history entry.

## Tiered constrained snapping

Every candidate appears before commit with source, distance, floor, confidence, and affected association.

- A unique eligible same-floor XY candidate at $d \le 0.50\,\text{m}$ snaps on release.
- Eligible candidates at $0.50 < d \le 3.0\,\text{m}$ are review suggestions and require explicit acceptance.
- Multiple eligible candidates are ambiguous and never snap automatically.
- Candidates beyond 3.0 m are not proposed by default.
- Floor, scene Z, source altitude, and conveyance association never change because of an XY snap.
- Cross-floor snap is prohibited for ordinary nodes.

Both bands are labelled provisional and point to [Validate 3D graph snapping against the companion JR datasets](https://github.com/dmalmq/imdf-map-application/issues/33). A profile override shows old/new values, scope, and a required reason before it becomes a staged history entry.

## State model and module seams

A pure prototype editor module owns the full staged state:

- synthetic baseline and current graph;
- active tool and active floor;
- semantic selection;
- pending add/move/connect/delete operation;
- snap candidates and chosen candidate;
- findings and local evaluation state;
- association, exception, and profile-override drafts;
- past/future history;
- full-check and fake-save state;
- locale, reduced-motion, and scene presentation state.

The module exposes one small interface to the React workspace: current state plus named user actions. It hides history restoration, snap classification, structural preflight, local finding recomputation, and change summarization. Scene, queue, inspector, toolbar, and prototype-state panel consume that interface rather than each maintaining competing state.

Every committed geometry, association, accepted-exception, or profile change stores one complete synchronized snapshot in bounded history. Undo and Redo therefore restore graph geometry, QA state, selection validity, and change summaries together. Selection/camera-only changes are not history entries.

## Structural rejection and semantic feedback

A structurally invalid operation is rejected before commit. Prototype cases include:

- duplicate connection;
- dangling or identical connector endpoints;
- non-finite control-point geometry;
- deletion that would leave an unusable graph.

The scene remains on the prior state, the attempted draft remains explainable, and the inspector states the violated invariant and recovery action.

A structurally valid edit commits immediately, then local affected rules recompute. The workspace reports a finding delta: resolved, unchanged, reopened, or newly exposed. Broader connectivity/statistical checks remain pending until Check.

Semantic findings never block editing or fake Save. The producer may:

- correct the geometry;
- confirm or replace a conveyance association;
- accept an exception with a required reason;
- make a scoped validation-profile override with before/after values and a reason.

## Prototype proof stories

The synthetic B1-to-1F station fragment supports six repeatable stories:

1. **Repair endpoint:** open `Endpoint off stair`, drag the B1 endpoint, preview a unique 0.31 m snap, commit it, then Undo and Redo.
2. **Create connector:** add a missing junction on the explicitly active B1 plane, choose it and an existing 1F endpoint, confirm the stair candidate, add an interior landing handle, and commit.
3. **Reject invalid edge:** attempt a duplicate same-floor connection and observe rejection with no graph/history mutation.
4. **Resolve uncertainty:** open a 0.84 m floor-drift Review, inspect an explicit floor reassignment, then fix it or accept an exception with a reason. Reset the story and stage a scoped profile override with before/after values and a reason.
5. **Delete with consequences:** select a graph junction with an incident edge, inspect the dependency preview, commit deletion, then Undo.
6. **Check and save:** run a full Check, inspect structural status, semantic finding counts, and staged changes, then exercise a fake Save-as-new-version confirmation.

Together the stories expose select, add, move, connect, delete, snap, floor reassignment, undo, redo, association, exception, profile override, invalid-operation recovery, and save readiness.

## Prototype shell and state visibility

The throwaway route is selected by `?prototype=graph-editing`; normal viewer and gallery entry behavior remains unchanged when the parameter is absent.

The shell includes:

- English/Japanese locale control;
- reduced-motion control;
- scenario reset;
- a compact prototype-state panel showing tool, floor, selection, pending operation, snap band, history depth, staged change counts, finding delta, Check state, locale, and reduced motion.

Every user-facing string exists in Japanese and English. Keyboard focus is visible. Tool shortcuts do not fire in text inputs. Reduced motion removes camera/floor interpolation without changing editing or QA state.

## Verification boundary

This is disposable UI/state prototype code:

- no production persistence, API, Rust, KVB, MapLibre, or renderer changes;
- no automated tests or production-grade error handling;
- TypeScript and production build must pass;
- browser proof at 1440×900 must exercise all five stories, keyboard focus, locale, reduced motion, and zero overlap or page-level overflow;
- the full state panel must make every meaningful transition inspectable;
- the prototype branch and behavior verdict are linked from the Wayfinder ticket, then kept out of `main`.

## Out of scope

- Choosing MapLibre, deck.gl, Cesium, three.js, or another production renderer.
- Measuring real 3D picking accuracy or performance.
- Loading the 171.6 MiB Tokyo tile leaf.
- Confirming the provisional snap bands against missing companion JR datasets.
- Designing the final renderer-neutral material/icon language.
- Implementing persistence, publication, collaboration, permissions, or conflict resolution.
- Editing venue walls, openings, stairs, escalators, elevator polygons, or other venue geometry.
