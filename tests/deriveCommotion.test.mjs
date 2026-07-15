import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BURST_MIN_COUNT,
  BURST_RADIUS_M,
  BURST_WINDOW_MINUTES,
  deriveCommotion,
} from "../src/signals/deriveCommotion.js";
import { validateSignal } from "../src/signals/contract.js";
import { createLiveSignalStore } from "../src/signals/liveSignals.js";
import { SEATTLE_VIEWPORT } from "../src/signals/seaFire911Adapter.js";

const FIXED_NOW = new Date("2026-07-05T21:30:00Z");
const ctx = { now: () => FIXED_NOW };

// ~0.0045° lng ≈ 340m at Seattle's latitude; ~0.003° lat ≈ 334m.
const BASE = [-122.33, 47.6];

function dispatch(n, overrides = {}) {
  return {
    id: `sea-fire911:F${n}`,
    source: "sea-fire911",
    sourceId: `F${n}`,
    kind: "safety",
    label: `Dispatch ${n}`,
    geometry: { type: "point", coordinates: BASE, radiusM: 300 },
    intensity: 0.55,
    confidence: 0.9,
    observedAt: "2026-07-05T21:10:00Z",
    expiresAt: "2026-07-05T23:00:00Z",
    ...overrides,
  };
}

function at(lngOffset, latOffset) {
  return {
    type: "point",
    coordinates: [BASE[0] + lngOffset, BASE[1] + latOffset],
    radiusM: 300,
  };
}

describe("deriveCommotion", () => {
  it("emits one contract-valid commotion signal for a qualifying burst", () => {
    const derived = deriveCommotion(
      [dispatch(1), dispatch(2, { geometry: at(0.002, 0) }), dispatch(3, { geometry: at(0, 0.0015) })],
      ctx,
    );

    assert.equal(derived.length, 1);
    const [burst] = derived;
    assert.equal(validateSignal(burst).ok, true, validateSignal(burst).errors.join("; "));
    assert.equal(burst.kind, "commotion");
    assert.equal(burst.subkind, "dispatch_burst");
    assert.equal(burst.label, `Dispatch burst — 3 calls in ${BURST_WINDOW_MINUTES} min`);
    assert.equal(burst.raw.count, 3);
  });

  it(`stays quiet below ${BURST_MIN_COUNT} dispatches`, () => {
    const derived = deriveCommotion([dispatch(1), dispatch(2)], ctx);
    assert.equal(derived.length, 0);
  });

  it("does not cluster dispatches farther apart than the burst radius", () => {
    // Three calls in a wide triangle, each pair > BURST_RADIUS_M apart.
    const derived = deriveCommotion(
      [dispatch(1), dispatch(2, { geometry: at(0.02, 0) }), dispatch(3, { geometry: at(0, 0.015) })],
      ctx,
    );
    assert.equal(derived.length, 0);
  });

  it("chains members: a burst strung along a street clusters via pairwise proximity", () => {
    // 1—2 close, 2—3 close, 1—3 beyond the radius. Union-find should join all three.
    const derived = deriveCommotion(
      [dispatch(1), dispatch(2, { geometry: at(0.004, 0) }), dispatch(3, { geometry: at(0.008, 0) })],
      ctx,
    );
    assert.equal(derived.length, 1);
    assert.equal(derived[0].raw.count, 3);
  });

  it("ignores dispatches observed before the burst window", () => {
    const stale = { observedAt: "2026-07-05T20:30:00Z" }; // 60 min old
    const derived = deriveCommotion(
      [dispatch(1, stale), dispatch(2), dispatch(3)],
      ctx,
    );
    assert.equal(derived.length, 0);
  });

  it("ignores non-safety and non-point signals", () => {
    const traffic = dispatch(1, { kind: "traffic" });
    const line = dispatch(2, {
      geometry: { type: "polyline", coordinates: [BASE, [BASE[0] + 0.001, BASE[1]]] },
    });
    const derived = deriveCommotion([traffic, line, dispatch(3), dispatch(4)], ctx);
    assert.equal(derived.length, 0);
  });

  it("keeps a stable identity as new calls join — anchored on the earliest member", () => {
    const first = deriveCommotion([dispatch(1), dispatch(2), dispatch(3)], ctx);
    const grown = deriveCommotion(
      [dispatch(1), dispatch(2), dispatch(3), dispatch(4, { observedAt: "2026-07-05T21:25:00Z" })],
      ctx,
    );

    assert.equal(first[0].id, "derived-commotion:sea-fire911:F1");
    assert.equal(grown[0].id, first[0].id);
    assert.equal(grown[0].raw.count, 4);
  });

  it("scales intensity with burst size and severe members, capped at 0.9", () => {
    const minimum = deriveCommotion([dispatch(1), dispatch(2), dispatch(3)], ctx)[0];
    assert.equal(minimum.intensity, 0.5);

    const withSevere = deriveCommotion(
      [dispatch(1, { intensity: 0.8 }), dispatch(2), dispatch(3)],
      ctx,
    )[0];
    assert.equal(withSevere.intensity, 0.6);

    const pileup = deriveCommotion(
      Array.from({ length: 12 }, (_, i) => dispatch(i + 1, { intensity: 0.8 })),
      ctx,
    )[0];
    assert.equal(pileup.intensity, 0.9);
  });

  it("stamps observedAt from the latest member and expires on the commotion TTL", () => {
    const [burst] = deriveCommotion(
      [
        dispatch(1, { observedAt: "2026-07-05T21:05:00Z" }),
        dispatch(2, { observedAt: "2026-07-05T21:20:00Z" }),
        dispatch(3, { observedAt: "2026-07-05T21:12:00Z" }),
      ],
      ctx,
    );

    assert.equal(burst.observedAt, "2026-07-05T21:20:00Z");
    assert.equal(burst.expiresAt, "2026-07-05T22:05:00.000Z"); // +45 min commotion TTL
  });

  it("covers the burst footprint: radius grows with spread, floors on a tight pileup", () => {
    const tight = deriveCommotion([dispatch(1), dispatch(2), dispatch(3)], ctx)[0];
    assert.equal(tight.geometry.radiusM, 300);

    const spread = deriveCommotion(
      [dispatch(1), dispatch(2, { geometry: at(0.004, 0) }), dispatch(3, { geometry: at(0.008, 0) })],
      ctx,
    )[0];
    assert.equal(spread.geometry.radiusM > 300, true);
    assert.equal(spread.geometry.radiusM <= BURST_RADIUS_M + 150, true);
  });
});

describe("liveSignals deriver integration", () => {
  function burstStore({ pull, derivers }) {
    const updates = [];
    const store = createLiveSignalStore({
      adapters: [{ id: "stub", cadence: { intervalSec: 300 }, pull }],
      derivers,
      viewport: SEATTLE_VIEWPORT,
      onUpdate: (update) => updates.push(update),
      now: () => FIXED_NOW,
    });
    return { store, updates };
  }

  it("appends derived commotion to hotspots and signals without touching adapter counts", async () => {
    const { store, updates } = burstStore({
      pull: async () => [dispatch(1), dispatch(2), dispatch(3)],
      derivers: [deriveCommotion],
    });
    await store.tick();

    const [update] = updates;
    assert.equal(update.signalCount, 4); // 3 dispatches + 1 derived burst
    assert.equal(update.signals.filter((s) => s.kind === "commotion").length, 1);
    // Commotion renders with the safety style until CSS grows a class.
    assert.equal(update.hotspots.filter((h) => h.id.startsWith("derived-commotion:")).length, 1);
    // The derived signal belongs to no adapter — the feed pill stays honest.
    assert.deepEqual(update.adapterStates.map((s) => s.signalCount), [3]);
  });

  it("a throwing deriver degrades to adapter-only output, never kills ingestion", async () => {
    const { store, updates } = burstStore({
      pull: async () => [dispatch(1)],
      derivers: [
        () => {
          throw new Error("deriver bug");
        },
      ],
    });
    await store.tick();

    assert.equal(updates[0].status, "live");
    assert.equal(updates[0].signalCount, 1);
  });

  it("derived output is validated — an invalid derived signal is dropped, valid ones kept", async () => {
    const { store, updates } = burstStore({
      pull: async () => [dispatch(1), dispatch(2), dispatch(3)],
      derivers: [(signals, ctx2) => [{ junk: true }, ...deriveCommotion(signals, ctx2)]],
    });
    await store.tick();

    assert.equal(updates[0].signalCount, 4); // junk dropped, burst kept
  });
});
