import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateBatch, toHotspot } from "../src/signals/contract.js";
import {
  SEATTLE_VIEWPORT,
  createSeaFire911Adapter,
  pacificToUtc,
} from "../src/signals/seaFire911Adapter.js";

// 2026-07-05 is PDT (GMT-7): 14:03 wall clock = 21:03 UTC.
const FIXED_NOW = new Date("2026-07-05T21:30:00Z");
const ctx = { now: () => FIXED_NOW, log: () => {} };

// Shape copied from the live feed (verified 2026-07-05).
function feedRecord(overrides = {}) {
  return {
    address: "1522 3RD AVE",
    type: "Aid Response",
    datetime: "2026-07-05T14:03:00.000",
    latitude: "47.610173",
    longitude: "-122.337509",
    report_location: { type: "Point", coordinates: [-122.337509, 47.610173] },
    incident_number: "F260092800",
    ...overrides,
  };
}

function adapterFor(records, { status = 200 } = {}) {
  return createSeaFire911Adapter({
    fetchImpl: async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => records,
    }),
  });
}

describe("pacificToUtc", () => {
  it("resolves a PDT floating timestamp to UTC", () => {
    assert.equal(
      pacificToUtc("2026-07-05T14:03:00.000").toISOString(),
      "2026-07-05T21:03:00.000Z",
    );
  });

  it("resolves a PST floating timestamp to UTC", () => {
    assert.equal(
      pacificToUtc("2026-01-05T14:03:00.000").toISOString(),
      "2026-01-05T22:03:00.000Z",
    );
  });

  it("returns null on garbage", () => {
    assert.equal(pacificToUtc("not a time"), null);
    assert.equal(pacificToUtc(undefined), null);
  });
});

describe("seaFire911Adapter", () => {
  it("emits a fully valid safety batch from live-shaped records", async () => {
    const adapter = adapterFor([
      feedRecord(),
      feedRecord({ incident_number: "F260092801", type: "Brush Fire" }),
    ]);
    const signals = await adapter.pull(ctx);
    const { valid, rejected } = validateBatch(signals);

    assert.equal(rejected.length, 0);
    assert.equal(valid.length, 2);
    for (const signal of valid) {
      assert.equal(signal.kind, "safety");
      assert.equal(signal.source, "sea-fire911");
      assert.equal(signal.id, `sea-fire911:${signal.sourceId}`);
      assert.equal(signal.confidence, 0.9);
    }
  });

  it("converts feed time to UTC and stamps the safety TTL", async () => {
    const [signal] = await adapterFor([feedRecord()]).pull(ctx);

    assert.equal(signal.observedAt, "2026-07-05T21:03:00.000Z");
    assert.equal(
      new Date(signal.expiresAt).getTime() -
        new Date(signal.observedAt).getTime(),
      120 * 60_000,
    );
  });

  it("tiers intensity by dispatch severity", async () => {
    const signals = await adapterFor([
      feedRecord({ incident_number: "a", type: "Fire in Building" }),
      feedRecord({ incident_number: "b", type: "Motor Vehicle Incident" }),
      feedRecord({ incident_number: "c", type: "Aid Response" }),
    ]).pull(ctx);

    const byId = new Map(signals.map((s) => [s.sourceId, s]));
    assert.equal(byId.get("a").intensity, 0.8);
    assert.equal(byId.get("b").intensity, 0.55);
    assert.equal(byId.get("c").intensity, 0.3);
    assert.ok(byId.get("a").geometry.radiusM > byId.get("c").geometry.radiusM);
  });

  it("dedupes repeated incident numbers keeping the newest row", async () => {
    const signals = await adapterFor([
      feedRecord({ datetime: "2026-07-05T14:00:00.000" }),
      feedRecord({ datetime: "2026-07-05T14:10:00.000" }),
    ]).pull(ctx);

    assert.equal(signals.length, 1);
    assert.equal(signals[0].observedAt, "2026-07-05T21:10:00.000Z");
  });

  it("drops rows with missing coordinates or incident number", async () => {
    const signals = await adapterFor([
      feedRecord(),
      feedRecord({ incident_number: "F2", latitude: undefined }),
      feedRecord({ incident_number: undefined }),
    ]).pull(ctx);

    assert.equal(signals.length, 1);
  });

  it("drops dispatches already past their TTL", async () => {
    const signals = await adapterFor([
      feedRecord({ datetime: "2026-07-05T12:00:00.000" }), // 19:00Z + 2h < now
    ]).pull(ctx);

    assert.equal(signals.length, 0);
  });

  it("throws on HTTP failure instead of returning an empty snapshot", async () => {
    await assert.rejects(
      adapterFor([], { status: 503 }).pull(ctx),
      /HTTP 503/,
    );
  });

  it("keeps labels human and within 60 chars", async () => {
    const signals = await adapterFor([
      feedRecord({
        incident_number: "long",
        type: "Motor Vehicle Incident Freeway",
        address: "NORTHBOUND INTERSTATE 5 AT MERCER ST OFFRAMP TOWARD FAIRVIEW",
      }),
    ]).pull(ctx);

    assert.ok(signals[0].label.length <= 60);
    assert.notEqual(signals[0].label, signals[0].label.toUpperCase());
  });

  it("projects downtown dispatches into the Seattle viewport", async () => {
    const [signal] = await adapterFor([feedRecord()]).pull(ctx);
    const hotspot = toHotspot(signal, SEATTLE_VIEWPORT);

    assert.ok(hotspot);
    assert.equal(hotspot.type, "safety");
    assert.ok(hotspot.x > 0 && hotspot.x < 100);
    assert.ok(hotspot.y > 0 && hotspot.y < 100);
  });
});
