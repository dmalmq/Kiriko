# Navigation Route Storytelling Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This is a throwaway UI prototype; browser behavior replaces automated tests by explicit prototype contract.

**Goal:** Build three interactive Kiriko navigation and cross-floor route-storytelling models on an isolated prototype route.

**Architecture:** A query-param entry in `src/main.tsx` mounts a prototype-only React controller. The controller owns one deterministic route playback state shared across three independent presentation variants and one schematic SVG/CSS scene. No production viewer, renderer, route model, API, or persistence code changes.

**Tech Stack:** React 19, TypeScript, CSS, inline SVG, Vite.

## Global Constraints

- Production behavior and data models remain unchanged.
- The route is `/?prototype=navigation-story`; switching variants uses a floating bottom bar and preserves playback state.
- Optimize for knowing the next action; ordinary navigation shows only the active floor.
- Connector handoff automatically announces the conveyance and destination floor, pulls back, swaps floors, and settles on the next leg.
- Reduced motion preserves every state while replacing interpolation with discrete changes.
- Every user string is Japanese/English; machine state and distances use IBM Plex Mono.
- Reuse Kiriko tokens and visual rules: warm neutrals, one indigo interaction voice, 1 px hairlines, and only floating/raised shadows.
- Use synthetic Tokyo Station route data labelled as prototype data.
- Do not add dependencies, API calls, persistence, production error handling, or automated tests.

---

### Task 1: Shared playback controller and prototype route

**Files:**
- Create: `src/prototypes/navigation/navigationStory.ts`
- Create: `src/prototypes/navigation/NavigationStoryPrototype.tsx`
- Modify: `src/main.tsx:1-20`

**Interfaces:**
- Produces `StoryStepId`, `StoryStep`, `VariantId`, `Locale`, `STORY_STEPS`, `stepFloor(step)`, and `NavigationStoryPrototype`.
- `NavigationStoryPrototype` owns `variant`, `stepIndex`, `playback`, `overviewOpen`, `viewFloor`, `locale`, and `reducedMotion`.
- Playback advances one deterministic step at a time with a single timeout; pause clears it; replay returns to the connector-announcement step; completion stops playback.

- [ ] **Step 1: Define the route story contract**

Create `navigationStory.ts` with:

```ts
export type StoryStepId =
  | "ready"
  | "walk-b1"
  | "connector"
  | "pull-back"
  | "floor-change"
  | "settle-1f"
  | "walk-1f"
  | "complete";
export type FloorId = "B1" | "1F";
export type VariantId = "guided" | "rail" | "scrubber";
export type PlaybackState = "ready" | "playing" | "paused" | "complete";
export type PrototypeLocale = "en" | "ja";
export interface LocalizedText { en: string; ja: string }
export interface StoryStep {
  id: StoryStepId;
  floor: FloorId;
  durationMs: number;
  instruction: LocalizedText;
  detail: LocalizedText;
  distanceM: number;
}
```

Populate `STORY_STEPS` for B1 walking, escalator announcement, pull-back, floor change, settle, 1F walking, and arrival. Export `stepFloor` and localized variant labels.

- [ ] **Step 2: Build the shared controller**

Create `NavigationStoryPrototype.tsx`. Use one `useEffect` timer when `playback === "playing"`; advance to the next step after `durationMs`; at the final step set `playback` to `"complete"`. Expose actions for play/pause, restart, replay connector, overview toggle, manual floor view, return to route, locale, reduced motion, and variant switch.

- [ ] **Step 3: Route the query parameter**

In `src/main.tsx`, read `new URLSearchParams(window.location.search).get("prototype")`. Mount `<NavigationStoryPrototype />` when it equals `"navigation-story"`; otherwise preserve the existing viewer/gallery condition unchanged.

- [ ] **Step 4: Verify TypeScript structure**

Run: `pnpm exec tsc --noEmit`

Expected: zero diagnostics.

- [ ] **Step 5: Commit controller slice**

```bash
git add src/main.tsx src/prototypes/navigation/navigationStory.ts src/prototypes/navigation/NavigationStoryPrototype.tsx
git commit -m "prototype: add navigation story controller"
```

---

### Task 2: Shared scene and three independent variants

**Files:**
- Create: `src/prototypes/navigation/NavigationScene.tsx`
- Create: `src/prototypes/navigation/GuidedLegCard.tsx`
- Create: `src/prototypes/navigation/VerticalJourneyRail.tsx`
- Create: `src/prototypes/navigation/RouteScrubber.tsx`
- Modify: `src/prototypes/navigation/NavigationStoryPrototype.tsx`

**Interfaces:**
- `NavigationScene` consumes `step`, `viewFloor`, `overviewOpen`, `reducedMotion`, and `locale`.
- Each variant consumes the same `NavigationVariantProps`: current step/index, playback state, locale, route overview state, and controller callbacks.
- Variants own their layout markup; only scene state, data, and compact primitives are shared.

- [ ] **Step 1: Build the schematic active-floor scene**

Render a responsive SVG floor plate with room/wall masses, corridor route, selected escalator, alternative stair/elevator, start/destination markers, and floor label. Normal mode renders only `viewFloor`. Overview mode renders B1 and 1F as a temporary separated stack connected by an indigo vertical path. Apply step-specific classes for walking, connector, pull-back, floor-change, settle, and complete.

- [ ] **Step 2: Build Guided Leg Card**

Render a compact lower-left instruction card with next action, detail, remaining distance, current floor, play/pause, overview, and connector replay. Include a small route-leg strip; map remains dominant.

- [ ] **Step 3: Build Vertical Journey Rail**

Render a right-side floor/leg ladder with B1, escalator, and 1F stages, completed/current/upcoming states, current instruction, and the same recovery actions. Do not reuse Guided Leg Card layout.

- [ ] **Step 4: Build Route Scrubber**

Render a bottom timeline with every story step, a moving current marker, scrub buttons, play/pause, replay, and overview. Do not reuse either other variant's layout.

- [ ] **Step 5: Surface complete prototype state**

Add a compact inspector showing variant, playback, step, route floor, viewed floor, camera phase, overview, locale, and reduced-motion values. Add a polite live region with the current instruction and floor.

- [ ] **Step 6: Verify TypeScript structure**

Run: `pnpm exec tsc --noEmit`

Expected: zero diagnostics.

- [ ] **Step 7: Commit scene and variants**

```bash
git add src/prototypes/navigation
git commit -m "prototype: compare route storytelling models"
```

---

### Task 3: Kiriko styling, responsive behavior, and browser proof

**Files:**
- Create: `src/prototypes/navigation/navigationStoryPrototype.css`
- Modify: `src/prototypes/navigation/NavigationStoryPrototype.tsx`

**Interfaces:**
- CSS is scoped under `.navigation-prototype` and does not alter production viewer selectors.
- Desktop target: 1440 × 900. Mobile target: 390 × 844.

- [ ] **Step 1: Load the craft floor before editing CSS**

Read `skill://impeccable/reference/craft-floor.md` and enforce its bans together with `DESIGN.md`.

- [ ] **Step 2: Style the full-screen scene and shared shell**

Use existing token values locally under `.navigation-prototype`. Recreate the Kiriko ContextBar, quiet top actions, scene-first canvas, 1 px geometry, restrained labels, and one indigo selection voice. Add a bottom-center floating variant switcher that never covers route controls.

- [ ] **Step 3: Style each variant independently**

Give Guided Leg Card a compact lower-left card, Vertical Journey Rail a full-height right ladder, and Route Scrubber a wide bottom timeline. Ensure each differs structurally, not only by color or copy.

- [ ] **Step 4: Add mobile and reduced-motion behavior**

At widths below 720 px, convert the guided card and rail to compact bottom sheets, keep 44 px control targets, avoid overlap with the switcher, and preserve scene visibility. Under `prefers-reduced-motion` or the prototype toggle, remove animated transforms and transitions while retaining state changes.

- [ ] **Step 5: Run static checks**

Run: `pnpm exec tsc --noEmit`

Expected: zero diagnostics.

Run: `pnpm build`

Expected: Vite production build completes.

- [ ] **Step 6: Exercise the prototype in Chromium**

Start Vite, open `http://127.0.0.1:5173/?prototype=navigation-story`, and verify:

- each variant switch preserves current step;
- playback reaches B1 walk, escalator announcement, pull-back, 1F, and complete;
- pause freezes progression and restart resets it;
- route overview shows both floors and closes back to the active floor;
- manual floor selection exposes Return to route;
- connector replay restarts the handoff;
- EN/JA updates every visible user string;
- reduced motion keeps the same states without continuous movement;
- keyboard focus is visible;
- desktop and 390 px layouts have no overlap or horizontal overflow.

Capture one desktop and one mobile screenshot per variant at the connector or floor-change state.

- [ ] **Step 7: Run the bounded design finish pass**

Run the Impeccable detector once on changed UI targets, fix mechanical findings in one batch, and obtain a fresh finish review using the captured screenshots. Apply only material findings, recapture once, and stop polishing.

- [ ] **Step 8: Commit verified prototype**

```bash
git add src/prototypes/navigation
git commit -m "prototype: finish navigation comparison"
```

- [ ] **Step 9: Record branch pointer**

Push `prototype/navigation-route-storytelling` and attach its URL plus the selected model and behavior verdict to the Wayfinder ticket. Do not merge the branch into `main`.
