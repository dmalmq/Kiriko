import { describe, expect, it } from "vitest";
import {
  MAX_3D_RETRIES,
  fallbackNotice,
  initialSceneSource,
  reduceSceneSource,
  sourceProvenance,
  type SceneSourceState,
} from "./sceneSource";

const MOTION = { reducedMotion: false };
const REDUCED = { reducedMotion: true };

/** 3D requested and offered. */
function rendering(): SceneSourceState {
  return initialSceneSource({ requested: true, capabilitySupported: true, ...MOTION });
}

describe("initialSceneSource", () => {
  it("renders 3D when it was requested and the floor is met", () => {
    const state = rendering();
    expect(state.active).toBe("generated");
    expect(state.reason).toBeNull();
    expect(state.veil).toBe(false);
  });

  it("starts on 2D when the capability floor is unmet, naming why", () => {
    const state = initialSceneSource({
      requested: true,
      capabilitySupported: false,
      ...MOTION,
    });
    expect(state.active).toBe("fallback2d");
    expect(state.reason).toBe("capability_unmet");
    // Nothing was replaced, so there is nothing to veil.
    expect(state.veil).toBe(false);
  });

  it("starts on 2D with no reason when 3D was never requested", () => {
    const state = initialSceneSource({
      requested: false,
      capabilitySupported: true,
      ...MOTION,
    });
    expect(state.active).toBe("fallback2d");
    expect(state.reason).toBeNull();
  });
});

describe("reduceSceneSource", () => {
  it("veils the swap when a load fails, then clears the veil", () => {
    const failed = reduceSceneSource(rendering(), { type: "load_failed" }, MOTION);
    expect(failed.active).toBe("fallback2d");
    expect(failed.reason).toBe("load_failed");
    expect(failed.veil).toBe(true);

    const settled = reduceSceneSource(failed, { type: "veil_finished" }, MOTION);
    expect(settled.veil).toBe(false);
    expect(settled.active).toBe("fallback2d");
  });

  it("replaces the source immediately under reduced motion, with no veil", () => {
    const failed = reduceSceneSource(rendering(), { type: "load_failed" }, REDUCED);
    expect(failed.active).toBe("fallback2d");
    expect(failed.veil).toBe(false);
  });

  it("never flaps back on its own after a load failure or a user's choice", () => {
    for (const event of [{ type: "load_failed" }, { type: "user_chose_2d" }] as const) {
      let state = reduceSceneSource(rendering(), event, MOTION);
      state = reduceSceneSource(state, { type: "veil_finished" }, MOTION);
      // Every event short of an explicit retry leaves the reviewer on 2D.
      for (const noise of [
        { type: "scene_ready" },
        { type: "context_restored" },
      ] as const) {
        state = reduceSceneSource(state, noise, MOTION);
        expect(state.active).toBe("fallback2d");
      }
    }
  });

  it("returns to 3D only when the reviewer asks", () => {
    const chosen = reduceSceneSource(rendering(), { type: "user_chose_2d" }, MOTION);
    expect(chosen.active).toBe("fallback2d");
    const retried = reduceSceneSource(chosen, { type: "retry_requested" }, MOTION);
    expect(retried.active).toBe("generated");
    expect(retried.reason).toBeNull();
    expect(retried.veil).toBe(true);
  });

  it("recovers automatically from a lost context that comes back", () => {
    const lost = reduceSceneSource(rendering(), { type: "context_lost" }, MOTION);
    expect(lost.active).toBe("fallback2d");
    expect(lost.reason).toBe("context_lost");

    const restored = reduceSceneSource(lost, { type: "context_restored" }, MOTION);
    // A lost context is transient, and #26's mechanism is to re-establish the
    // view — unlike a quality fallback, which stays put.
    expect(restored.active).toBe("generated");
    expect(restored.reason).toBeNull();
  });

  it("stops recovering once the retry budget is spent, rather than thrashing", () => {
    let state = rendering();
    for (let attempt = 0; attempt < MAX_3D_RETRIES; attempt += 1) {
      state = reduceSceneSource(state, { type: "context_lost" }, MOTION);
      state = reduceSceneSource(state, { type: "context_restored" }, MOTION);
      expect(state.active).toBe("generated");
    }
    expect(state.retriesLeft).toBe(0);

    state = reduceSceneSource(state, { type: "context_lost" }, MOTION);
    state = reduceSceneSource(state, { type: "context_restored" }, MOTION);
    // A GPU that keeps dying leaves the reviewer on a view that works.
    expect(state.active).toBe("fallback2d");
    expect(state.reason).toBe("context_lost");

    // And an explicit retry cannot conjure attempts that are gone.
    expect(reduceSceneSource(state, { type: "retry_requested" }, MOTION).active).toBe(
      "fallback2d",
    );
  });

  it("ignores a capability failure it has already acted on", () => {
    const unmet = reduceSceneSource(rendering(), { type: "capability_unmet" }, MOTION);
    const again = reduceSceneSource(unmet, { type: "capability_unmet" }, MOTION);
    expect(again).toEqual(unmet);
  });

  it("never lets a retry be spent when the floor itself is unmet", () => {
    const unmet = initialSceneSource({
      requested: true,
      capabilitySupported: false,
      ...MOTION,
    });
    // Retrying a device that cannot render 3D would veil the canvas and land
    // back on 2D; the offer is simply not there.
    const retried = reduceSceneSource(unmet, { type: "retry_requested" }, MOTION);
    expect(retried.active).toBe("fallback2d");
    expect(retried.retriesLeft).toBe(unmet.retriesLeft);
  });

  it("holds exactly one active source at every step", () => {
    let state = rendering();
    const events = [
      { type: "scene_ready" },
      { type: "context_lost" },
      { type: "context_restored" },
      { type: "load_failed" },
      { type: "veil_finished" },
      { type: "retry_requested" },
      { type: "user_chose_2d" },
    ] as const;
    for (const event of events) {
      state = reduceSceneSource(state, event, MOTION);
      // The type admits one source; this asserts the value never drifts to
      // something that could render two.
      expect(["generated", "fallback2d"]).toContain(state.active);
    }
  });

  it("climbs to 3D when the reviewer asks for it, and says it was asked for", () => {
    // The only way into 3D after a 2D-only start: the toggle. The generated
    // scene is the rung every published version retains, so that is where an
    // explicit ask lands; the tile document climbs from there when it answers.
    const off = initialSceneSource({ requested: false, capabilitySupported: true, ...MOTION });
    const on = reduceSceneSource(off, { type: "user_chose_3d" }, MOTION);
    expect(on.active).toBe("generated");
    expect(on.reason).toBeNull();
    expect(on.requested).toBe(true);
  });

  it("does not spend the recovery budget on a deliberate choice", () => {
    // `retriesLeft` bounds *automatic* recoveries so a failing GPU cannot loop.
    // A reviewer toggling the view is not a recovery, and a toggle that stops
    // working after two uses would be a bug rather than a budget.
    let state = initialSceneSource({ requested: false, capabilitySupported: true, ...MOTION });
    for (let i = 0; i < MAX_3D_RETRIES + 2; i += 1) {
      state = reduceSceneSource(state, { type: "user_chose_3d" }, MOTION);
      expect(state.active).toBe("generated");
      state = reduceSceneSource(state, { type: "user_chose_2d" }, MOTION);
      expect(state.active).toBe("fallback2d");
    }
    expect(state.retriesLeft).toBe(MAX_3D_RETRIES);
  });

  it("refuses 3D on a device below the floor, naming the reason", () => {
    // The toggle is hidden on such a device, so this is the defensive path:
    // answer with the honest reason rather than a 3D state nothing can draw.
    const off = initialSceneSource({ requested: false, capabilitySupported: false, ...MOTION });
    const asked = reduceSceneSource(off, { type: "user_chose_3d" }, MOTION);
    expect(asked.active).toBe("fallback2d");
    expect(asked.reason).toBe("capability_unmet");
    expect(asked.requested).toBe(true);
  });

  it("does not resurrect a tile scene already given up this session", () => {
    // #30 section 5: a source given up stays given up for the session. Leaving
    // and re-entering 3D must not re-ask for a package that would not start.
    const dropped = reduceSceneSource(renderingTiles(), { type: "load_failed" }, MOTION);
    expect(dropped.droppedFrom).toBe("tiles");
    const off = reduceSceneSource(dropped, { type: "user_chose_2d" }, MOTION);
    const back = reduceSceneSource(off, { type: "user_chose_3d" }, MOTION);
    expect(back.active).toBe("generated");
    expect(back.droppedFrom).toBe("tiles");
    expect(reduceSceneSource(back, { type: "tiles_ready" }, MOTION).active).toBe("generated");
  });

  it("veils the climb into 3D, and never under reduced motion", () => {
    const off = initialSceneSource({ requested: false, capabilitySupported: true, ...MOTION });
    expect(reduceSceneSource(off, { type: "user_chose_3d" }, MOTION).veil).toBe(true);
    expect(reduceSceneSource(off, { type: "user_chose_3d" }, REDUCED).veil).toBe(false);
  });

  it("says nothing when the reviewer chose 2D, and speaks up when it was taken", () => {
    // The notice explains losses. A choice is not one, and the toggle beside it
    // already offers the way back; the three involuntary reasons still explain
    // themselves, which is the distinction worth keeping.
    const chose = reduceSceneSource(rendering(), { type: "user_chose_2d" }, MOTION);
    expect(chose.active).toBe("fallback2d");
    expect(fallbackNotice(chose)).toBeNull();
    for (const event of [{ type: "load_failed" }, { type: "context_lost" }] as const) {
      expect(fallbackNotice(reduceSceneSource(rendering(), event, MOTION))).not.toBeNull();
    }
    expect(
      fallbackNotice(
        initialSceneSource({ requested: true, capabilitySupported: false, ...MOTION }),
      ),
    ).not.toBeNull();
  });
});

describe("sourceProvenance", () => {
  it("names the active source in both languages", () => {
    const generated = sourceProvenance(rendering());
    expect(generated.badge.en).toBe("Generated 3D");
    expect(generated.provenance.en).toContain("evidence-backed");
    expect(generated.badge.ja).not.toBe("");
    expect(generated.provenance.ja).not.toBe("");

    const fallback = sourceProvenance(
      reduceSceneSource(rendering(), { type: "load_failed" }, MOTION),
    );
    expect(fallback.badge.en).toBe("2D");
    expect(fallback.provenance.en).toBe("Universal 2D fallback");
    expect(fallback.provenance.ja).not.toBe("");
  });

  it("does not dress a fallback up as a source that is not rendering", () => {
    const fallback = sourceProvenance(
      reduceSceneSource(rendering(), { type: "context_lost" }, MOTION),
    );
    expect(fallback.provenance.en.toLowerCase()).not.toContain("generated");
  });
});

/** 3D requested, the floor met, and the version has an activated package. */
function renderingTiles(): SceneSourceState {
  return initialSceneSource({
    requested: true,
    capabilitySupported: true,
    tilesAvailable: true,
    ...MOTION,
  });
}

describe("the tiles rung", () => {
  it("climbs to tiles when the version turns out to have a package", () => {
    // Availability is learned by asking for the document, so the first state
    // is generated and the answer arrives a moment later.
    const state = reduceSceneSource(rendering(), { type: "tiles_ready" }, MOTION);
    expect(state.active).toBe("tiles");
    expect(state.reason).toBeNull();
  });

  it("does not climb back to tiles after the tile scene was given up", () => {
    const fell = reduceSceneSource(renderingTiles(), { type: "load_failed" }, MOTION);
    expect(reduceSceneSource(fell, { type: "tiles_ready" }, MOTION).active).toBe("generated");
  });

  it("does not climb to tiles from 2D", () => {
    const twoD = reduceSceneSource(rendering(), { type: "user_chose_2d" }, MOTION);
    expect(reduceSceneSource(twoD, { type: "tiles_ready" }, MOTION).active).toBe("fallback2d");
  });

  it("starts on tiles when the version has an activated package", () => {
    const state = renderingTiles();
    expect(state.active).toBe("tiles");
    expect(state.reason).toBeNull();
  });

  it("starts on generated when the version has none", () => {
    expect(rendering().active).toBe("generated");
  });

  it("falls one rung to generated when the tile scene will not load", () => {
    // Not to 2D: the venue always retains a generated scene (#30 section 1),
    // and dropping past it would discard 3D the device can render.
    const state = reduceSceneSource(renderingTiles(), { type: "load_failed" }, MOTION);
    expect(state.active).toBe("generated");
    expect(state.reason).toBeNull();
    expect(state.veil).toBe(true);
  });

  it("retries the tile scene once before giving it up", () => {
    const first = reduceSceneSource(renderingTiles(), { type: "load_failed" }, MOTION);
    expect(first.tileRetriesLeft).toBe(0);
    // A second failure of the generated scene is the generated scene's
    // failure, and lands on 2D as it always did.
    const second = reduceSceneSource(first, { type: "load_failed" }, MOTION);
    expect(second.active).toBe("fallback2d");
    expect(second.reason).toBe("load_failed");
  });

  it("never climbs back to tiles on its own", () => {
    // Fallback is one-way (#30 section 5): a view that silently oscillates
    // between two sources is worse than one that is merely less detailed.
    const fell = reduceSceneSource(renderingTiles(), { type: "load_failed" }, MOTION);
    for (const type of ["scene_ready", "context_restored", "retry_requested"] as const) {
      expect(reduceSceneSource(fell, { type }, MOTION).active).not.toBe("tiles");
    }
  });

  it("reports tiles in the badge and the provenance line", () => {
    const provenance = sourceProvenance(renderingTiles());
    expect(provenance.badge.en).toBe("3D Tiles");
    expect(provenance.provenance.en).toBe("3D Tiles · source-authored detail");
    expect(provenance.badge.ja.length).toBeGreaterThan(0);
    expect(provenance.provenance.ja).toContain("3D Tiles");
  });

  it("updates the badge the moment it falls back to generated", () => {
    const fell = reduceSceneSource(renderingTiles(), { type: "load_failed" }, MOTION);
    expect(sourceProvenance(fell).badge.en).toBe("Generated 3D");
  });

  it("explains a drop from tiles to generated in both languages", () => {
    const fell = reduceSceneSource(renderingTiles(), { type: "load_failed" }, MOTION);
    const notice = fallbackNotice(fell);
    expect(notice?.en.length).toBeGreaterThan(0);
    expect(notice?.ja.length).toBeGreaterThan(0);
    expect(notice?.en.toLowerCase()).toContain("generated");
  });

  it("replaces the source without a veil under reduced motion", () => {
    const state = reduceSceneSource(renderingTiles(), { type: "load_failed" }, REDUCED);
    expect(state.active).toBe("generated");
    expect(state.veil).toBe(false);
  });

  it("goes straight to 2D from tiles when the device loses its context", () => {
    // A lost context is not the tile scene's fault and the generated scene
    // needs the same GPU, so stepping down a rung would fail again immediately.
    const state = reduceSceneSource(renderingTiles(), { type: "context_lost" }, MOTION);
    expect(state.active).toBe("fallback2d");
    expect(state.reason).toBe("context_lost");
  });
});
