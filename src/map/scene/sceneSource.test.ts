import { describe, expect, it } from "vitest";
import {
  MAX_3D_RETRIES,
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
