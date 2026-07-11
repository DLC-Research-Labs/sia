import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLiveSignalStore } from "../src/signals/liveSignals.js";
import { SEATTLE_VIEWPORT } from "../src/signals/seaFire911Adapter.js";

const FIXED_NOW = new Date("2026-07-05T21:30:00Z");

function signal(overrides = {}) {
  return {
    id: "stub:one",
    source: "stub",
    sourceId: "one",
    kind: "safety",
    label: "Test dispatch",
    geometry: { type: "point", coordinates: [-122.33, 47.6], radiusM: 300 },
    intensity: 0.5,
    confidence: 0.9,
    observedAt: "2026-07-05T21:00:00Z",
    expiresAt: "2026-07-05T23:00:00Z",
    ...overrides,
  };
}

function storeWith(pulls, { now = () => FIXED_NOW } = {}) {
  let call = 0;
  const updates = [];
  const store = createLiveSignalStore({
    adapters: [
      {
        id: "stub",
        cadence: { intervalSec: 300 },
        pull: async () => {
          const result = pulls[Math.min(call, pulls.length - 1)];
          call += 1;
          if (result instanceof Error) throw result;
          return result;
        },
      },
    ],
    viewport: SEATTLE_VIEWPORT,
    onUpdate: (update) => updates.push(update),
    now,
  });
  return { store, updates };
}

describe("createLiveSignalStore", () => {
  it("projects a valid pull into hotspots and reports live", async () => {
    const { store, updates } = storeWith([[signal()]]);
    await store.tick();

    assert.equal(updates.length, 1);
    assert.equal(updates[0].status, "live");
    assert.equal(updates[0].signalCount, 1);
    assert.equal(updates[0].hotspots[0].type, "safety");
  });

  it("drops invalid signals and counts them as rejected", async () => {
    const { store, updates } = storeWith([[signal(), { junk: true }]]);
    await store.tick();

    assert.equal(updates[0].signalCount, 1);
    assert.equal(updates[0].rejectedCount, 1);
  });

  it("keeps the previous snapshot when a pull fails", async () => {
    const { store, updates } = storeWith([[signal()], new Error("feed down")]);
    await store.tick();
    await store.tick();

    assert.equal(updates[1].status, "error");
    assert.equal(updates[1].signalCount, 1); // stale beats blank
  });

  it("replaces the snapshot wholesale on each successful pull", async () => {
    const { store, updates } = storeWith([
      [signal(), signal({ id: "stub:two", sourceId: "two" })],
      [signal({ id: "stub:three", sourceId: "three" })],
    ]);
    await store.tick();
    await store.tick();

    assert.equal(updates[0].signalCount, 2);
    assert.equal(updates[1].signalCount, 1);
    assert.equal(updates[1].hotspots[0].id, "stub:three");
  });

  it("prunes signals past expiresAt even without a new pull", async () => {
    let currentNow = FIXED_NOW;
    const { store, updates } = storeWith(
      [[signal({ expiresAt: "2026-07-05T22:00:00Z" })], new Error("feed down")],
      { now: () => currentNow },
    );
    await store.tick();
    assert.equal(updates[0].signalCount, 1);

    currentNow = new Date("2026-07-05T22:30:00Z"); // past expiry
    await store.tick(); // pull fails, but pruning still applies
    assert.equal(updates[1].signalCount, 0);
  });

  it("reports per-adapter states and degrades — one dead feed does not paint everything red", async () => {
    const updates = [];
    const store = createLiveSignalStore({
      adapters: [
        {
          id: "alive",
          name: "Alive Feed",
          cadence: { intervalSec: 300 },
          pull: async () => [signal({ id: "alive:one", source: "alive" })],
        },
        {
          id: "dead",
          name: "Dead Feed",
          cadence: { intervalSec: 300 },
          pull: async () => {
            throw new Error("HTTP 500");
          },
        },
      ],
      viewport: SEATTLE_VIEWPORT,
      onUpdate: (update) => updates.push(update),
      now: () => FIXED_NOW,
    });
    await store.tick();

    assert.equal(updates[0].status, "degraded");
    assert.equal(updates[0].signalCount, 1); // the live feed still shows
    assert.deepEqual(
      updates[0].adapterStates.map(({ id, name, status, error, signalCount }) => ({
        id, name, status, error, signalCount,
      })),
      [
        { id: "alive", name: "Alive Feed", status: "live", error: null, signalCount: 1 },
        { id: "dead", name: "Dead Feed", status: "error", error: "HTTP 500", signalCount: 0 },
      ],
    );
  });

  it("reports error only when every adapter is down, live when all recover", async () => {
    const updates = [];
    let fail = true;
    const failingAdapter = (id) => ({
      id,
      cadence: { intervalSec: 300 },
      pull: async () => {
        if (fail) throw new Error(`${id} down`);
        return [signal({ id: `${id}:one`, source: id })];
      },
    });
    const store = createLiveSignalStore({
      adapters: [failingAdapter("a"), failingAdapter("b")],
      viewport: SEATTLE_VIEWPORT,
      onUpdate: (update) => updates.push(update),
      now: () => FIXED_NOW,
    });

    await store.tick();
    assert.equal(updates[0].status, "error");
    assert.equal(updates[0].adapterStates.every((s) => s.status === "error"), true);
    // Adapter without a name falls back to its id.
    assert.equal(updates[0].adapterStates[0].name, "a");

    fail = false;
    await store.tick();
    assert.equal(updates[1].status, "live");
    assert.equal(updates[1].adapterStates.every((s) => s.status === "live"), true);
  });

  it("excludes signals outside the viewport from hotspots", async () => {
    const outside = signal({
      id: "stub:far",
      sourceId: "far",
      geometry: { type: "point", coordinates: [-121.0, 47.6], radiusM: 300 },
    });
    const { store, updates } = storeWith([[signal(), outside]]);
    await store.tick();

    assert.equal(updates[0].signalCount, 1);
  });
});
