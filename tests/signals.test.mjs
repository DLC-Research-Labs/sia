import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SIGNAL_KINDS,
  validateBatch,
  validateSignal,
  toHotspot,
} from "../src/signals/contract.js";
import { MOCK_VIEWPORT, mockAdapter } from "../src/signals/mockAdapter.js";

const FIXED_NOW = new Date("2026-07-05T22:00:00Z");
const ctx = { now: () => FIXED_NOW };

function validSignal(overrides = {}) {
  return {
    id: "test:one",
    source: "test",
    sourceId: "one",
    kind: "traffic",
    label: "Test slowdown",
    geometry: { type: "point", coordinates: [-122.33, 47.6], radiusM: 500 },
    intensity: 0.5,
    confidence: 0.9,
    observedAt: "2026-07-05T22:00:00Z",
    expiresAt: "2026-07-05T22:15:00Z",
    ...overrides,
  };
}

describe("validateSignal", () => {
  it("accepts a minimal valid point signal", () => {
    const result = validateSignal(validSignal());
    assert.deepEqual(result, { ok: true, errors: [] });
  });

  it("rejects an id that is not source:sourceId", () => {
    const result = validateSignal(validSignal({ id: "wrong" }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('id must be "test:one"')));
  });

  it("rejects unknown kinds and out-of-range intensity", () => {
    const result = validateSignal(validSignal({ kind: "vibes", intensity: 1.5 }));
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 2);
  });

  it("requires expiresAt — nothing haunts the map", () => {
    const signal = validSignal();
    delete signal.expiresAt;
    assert.equal(validateSignal(signal).ok, false);
  });

  it("requires radiusM on point geometry", () => {
    const result = validateSignal(
      validSignal({ geometry: { type: "point", coordinates: [-122.33, 47.6] } }),
    );
    assert.equal(result.ok, false);
  });

  it("accepts polyline geometry without radiusM", () => {
    const result = validateSignal(
      validSignal({
        geometry: {
          type: "polyline",
          coordinates: [
            [-122.34, 47.6],
            [-122.32, 47.61],
          ],
        },
      }),
    );
    assert.deepEqual(result, { ok: true, errors: [] });
  });
});

describe("validateBatch", () => {
  it("drops invalid records without killing the batch", () => {
    const { valid, rejected } = validateBatch([
      validSignal(),
      validSignal({ id: "broken", sourceId: "two" }),
      null,
    ]);
    assert.equal(valid.length, 1);
    assert.equal(rejected.length, 2);
    assert.ok(rejected.every((r) => r.errors.length > 0));
  });
});

describe("toHotspot", () => {
  it("projects a centered point into the render plane", () => {
    const signal = validSignal({
      geometry: { type: "point", coordinates: [-122.33, 47.61], radiusM: 1000 },
    });
    const hotspot = toHotspot(signal, MOCK_VIEWPORT);

    assert.ok(hotspot);
    assert.equal(hotspot.type, "traffic");
    assert.ok(hotspot.x > 0 && hotspot.x < 100);
    assert.ok(hotspot.y > 0 && hotspot.y < 100);
    assert.ok(hotspot.radius > 2);
    assert.equal(hotspot.intensity, 0.5);
  });

  it("returns null for signals outside the viewport", () => {
    const signal = validSignal({
      geometry: { type: "point", coordinates: [-121.0, 47.61], radiusM: 500 },
    });
    assert.equal(toHotspot(signal, MOCK_VIEWPORT), null);
  });

  it("renders commotion with the safety style until CSS grows a class", () => {
    const signal = validSignal({ kind: "commotion" });
    assert.equal(toHotspot(signal, MOCK_VIEWPORT).type, "safety");
  });
});

describe("mockAdapter", () => {
  it("emits only kinds it declares", async () => {
    const signals = await mockAdapter.pull(ctx);
    assert.ok(signals.length > 0);
    for (const signal of signals) {
      assert.ok(mockAdapter.kinds.includes(signal.kind));
      assert.ok(SIGNAL_KINDS.includes(signal.kind));
    }
  });

  it("emits a fully valid batch", async () => {
    const { valid, rejected } = validateBatch(await mockAdapter.pull(ctx));
    assert.equal(rejected.length, 0);
    assert.equal(valid.length, 4);
  });

  it("emits signals that all project into the mock viewport", async () => {
    const signals = await mockAdapter.pull(ctx);
    for (const signal of signals) {
      const hotspot = toHotspot(signal, MOCK_VIEWPORT);
      assert.ok(hotspot, `${signal.id} should project into the viewport`);
    }
  });

  it("stamps expiry from the kind's default TTL", async () => {
    const [traffic] = await mockAdapter.pull(ctx);
    assert.equal(traffic.kind, "traffic");
    assert.equal(
      new Date(traffic.expiresAt).getTime() - FIXED_NOW.getTime(),
      15 * 60_000,
    );
  });
});
